import { AppError } from '@documenso/lib/errors/app-error';
import { scheduleSigninLinkRetry } from '@documenso/lib/jobs/client/schedule-delayed-job';
import { isTwoFactorAuthenticationEnabled } from '@documenso/lib/server-only/2fa/is-2fa-availble';
import { validateTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/validate-2fa';
import { assertEmailLinkSigninEnabled } from '@documenso/lib/server-only/auth/email-link-kill-switch';
import {
  EMAIL_LINK_SIGNIN_IDENTIFIER,
  hashEmailLinkToken,
  sendEmailLinkSignin,
} from '@documenso/lib/server-only/auth/send-email-link-signin';
import { rateLimitResponse } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import {
  emailLinkAuthorizeRateLimit,
  emailLinkRequestEmailCeiling,
  emailLinkRequestRateLimit,
} from '@documenso/lib/server-only/rate-limit/rate-limits';
import { deletedServiceAccountEmail } from '@documenso/lib/server-only/user/service-accounts/deleted-account';
import { legacyServiceAccountEmail } from '@documenso/lib/server-only/user/service-accounts/legacy-service-account';
import { zEmail } from '@documenso/lib/utils/zod';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import { UserSecurityAuditLogType } from '@prisma/client';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { AuthenticationErrorCode } from '../lib/errors/error-codes';
import { onAuthorize } from '../lib/utils/authorizer';
import type { HonoAuthContext } from '../types/context';

export const ZEmailLinkRequestSchema = z.object({
  email: zEmail().min(1),
});

export const ZEmailLinkAuthorizeSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  totpCode: z.string().trim().optional(),
  backupCode: z.string().trim().optional(),
});

export const EMAIL_LINK_TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';

const EMAIL_LINK_MAX_TWO_FACTOR_ATTEMPTS = 5;

/**
 * Add one to the link's two-factor attempt count in a single statement and return the new
 * count, or null when the link was used up in the meantime. Every attempt counts, right or
 * wrong, so at most EMAIL_LINK_MAX_TWO_FACTOR_ATTEMPTS codes are ever checked for one link.
 */
const countTwoFactorAttempt = async (verificationTokenId: number) => {
  const rows = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE "VerificationToken"
    SET "metadata" = jsonb_set(
      COALESCE("metadata"::jsonb, '{}'::jsonb),
      '{failedTwoFactorAttempts}',
      to_jsonb(COALESCE(("metadata"->>'failedTwoFactorAttempts')::int, 0) + 1)
    )
    WHERE "id" = ${verificationTokenId} AND "completed" = false
    RETURNING ("metadata"->>'failedTwoFactorAttempts')::int AS "attempts"
  `;

  return rows[0]?.attempts ?? null;
};

/**
 * Passwordless sign-in for existing users (Solid Ten Sign).
 *
 * `/request` always answers the same way, so it does not reveal which emails have accounts.
 * `/authorize` is a POST made by the sign-in page after the person clicks a button, so mail
 * scanners that only fetch the link cannot use it up.
 */
export const emailLinkRoute = new Hono<HonoAuthContext>()
  .post('/request', sValidator('json', ZEmailLinkRequestSchema), async (c) => {
    assertEmailLinkSigninEnabled();

    const requestMetadata = c.get('requestMetadata');

    const { email } = c.req.valid('json');

    const ipAddress = requestMetadata.ipAddress ?? 'unknown';
    const emailKey = hashEmailLinkToken(email.toLowerCase()).slice(0, 32);

    // Per IP, and per email from this IP only: another caller cannot use up the owner's budget.
    const limitResult = await emailLinkRequestRateLimit.check({
      ip: ipAddress,
      identifier: `${emailKey}:${ipAddress}`,
    });

    const limited = rateLimitResponse(c, limitResult);

    if (limited) {
      throw new HTTPException(429, {
        res: limited,
      });
    }

    const isServiceAccount =
      email.toLowerCase() === legacyServiceAccountEmail() || email.toLowerCase() === deletedServiceAccountEmail();

    // Over the per-email ceiling the answer is the same, but no new link goes out.
    const ceiling = await emailLinkRequestEmailCeiling.check({ ip: `email:${emailKey}` });

    if (!isServiceAccount && !ceiling.isLimited) {
      // Not awaited: a known email must not answer slower than an unknown one.
      // Solid Ten: when the mail server refuses it, a fresh link is mailed again later (1, 5, 15 min).
      void sendEmailLinkSignin({ email }).catch(async (err) => {
        console.error(err);
        await scheduleSigninLinkRetry({ email }).catch((retryErr) => console.error(retryErr));
      });
    }

    return c.text('OK', 201);
  })
  .post('/authorize', sValidator('json', ZEmailLinkAuthorizeSchema), async (c) => {
    assertEmailLinkSigninEnabled();

    const requestMetadata = c.get('requestMetadata');

    const { token, totpCode, backupCode } = c.req.valid('json');

    const hashedToken = hashEmailLinkToken(token);

    const limitResult = await emailLinkAuthorizeRateLimit.check({
      ip: requestMetadata.ipAddress ?? 'unknown',
      identifier: hashedToken.slice(0, 16),
    });

    const limited = rateLimitResponse(c, limitResult);

    if (limited) {
      throw new HTTPException(429, {
        res: limited,
      });
    }

    const record = await prisma.verificationToken.findFirst({
      where: {
        token: hashedToken,
        identifier: EMAIL_LINK_SIGNIN_IDENTIFIER,
      },
      include: {
        user: true,
      },
    });

    if (!record || record.completed || record.expires.valueOf() <= Date.now()) {
      throw new AppError(AuthenticationErrorCode.InvalidToken, {
        message: 'This sign-in link is not valid or has expired',
        statusCode: 400,
      });
    }

    const { user } = record;

    // The email link replaces the password only. A user with 2FA still has to pass it.
    if (isTwoFactorAuthenticationEnabled({ user })) {
      if (!totpCode && !backupCode) {
        throw new AppError(EMAIL_LINK_TWO_FACTOR_REQUIRED, {
          message: 'Two-factor code required',
          statusCode: 401,
        });
      }

      // Solid Ten Sign (S-M2): count the attempt atomically before the code is checked, so
      // parallel guesses cannot all read the same old count.
      const attempt = await countTwoFactorAttempt(record.id);

      if (attempt === null || attempt > EMAIL_LINK_MAX_TWO_FACTOR_ATTEMPTS) {
        await prisma.verificationToken.updateMany({
          where: { id: record.id },
          data: { completed: true },
        });

        throw new AppError(AuthenticationErrorCode.InvalidToken, {
          message: 'This sign-in link is not valid or has expired',
          statusCode: 400,
        });
      }

      const isValid = await validateTwoFactorAuthentication({
        backupCode,
        totpCode,
        user,
      });

      if (!isValid) {
        await prisma.userSecurityAuditLog.create({
          data: {
            userId: user.id,
            ipAddress: requestMetadata.ipAddress,
            userAgent: requestMetadata.userAgent,
            type: UserSecurityAuditLogType.SIGN_IN_2FA_FAIL,
          },
        });

        // A stolen link must not allow unlimited guesses at the code.
        if (attempt >= EMAIL_LINK_MAX_TWO_FACTOR_ATTEMPTS) {
          await prisma.verificationToken.updateMany({
            where: { id: record.id },
            data: { completed: true },
          });
        }

        throw new AppError(AuthenticationErrorCode.InvalidTwoFactorCode, {
          message: 'The two-factor code is not correct.',
          statusCode: 401,
        });
      }
    }

    // Single use: only the request that flips `completed` gets a session.
    const consumed = await prisma.verificationToken.updateMany({
      where: {
        id: record.id,
        completed: false,
      },
      data: {
        completed: true,
      },
    });

    if (consumed.count !== 1) {
      throw new AppError(AuthenticationErrorCode.InvalidToken, {
        message: 'This sign-in link is not valid or has expired',
        statusCode: 400,
      });
    }

    // Refuses disabled accounts before anything else is written for the user.
    await onAuthorize({ userId: user.id }, c);

    // Opening the emailed link proves control of the address.
    if (!user.emailVerified) {
      await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          emailVerified: new Date(),
        },
      });
    }

    return c.text('', 201);
  });
