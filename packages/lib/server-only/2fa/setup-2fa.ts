import { prisma } from '@documenso/prisma';
import type { User } from '@prisma/client';
import { base32 } from '@scure/base';
import crypto from 'crypto';
import { createTOTPKeyURI } from 'oslo/otp';

import { DOCUMENSO_ENCRYPTION_KEY } from '../../constants/crypto';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { symmetricEncrypt } from '../../universal/crypto';

type SetupTwoFactorAuthenticationOptions = {
  user: Pick<User, 'id' | 'email'>;
};

const ISSUER = 'Solid Ten Sign';

export const TWO_FACTOR_ALREADY_ENABLED_MESSAGE =
  'Two-factor authentication is already on. Turn it off with a code before you set it up again.';

export const setupTwoFactorAuthentication = async ({ user }: SetupTwoFactorAuthenticationOptions) => {
  const key = DOCUMENSO_ENCRYPTION_KEY;

  if (!key) {
    throw new Error('MISSING_ENCRYPTION_KEY');
  }

  const secret = crypto.randomBytes(10);

  const backupCodes = Array.from({ length: 10 })
    .fill(null)
    .map(() => crypto.randomBytes(5).toString('hex'))
    .map((code) => `${code.slice(0, 5)}-${code.slice(5)}`.toUpperCase());

  const accountName = user.email;
  const uri = createTOTPKeyURI(ISSUER, accountName, secret);
  const encodedSecret = base32.encode(new Uint8Array(secret));

  // Solid Ten Sign (AUD-12): setup never touches 2FA that is on. Turning it off needs a
  // code (disable-2fa). The condition is in the write, so a race cannot pass it.
  const { count } = await prisma.user.updateMany({
    where: {
      id: user.id,
      twoFactorEnabled: false,
    },
    data: {
      twoFactorBackupCodes: symmetricEncrypt({
        data: JSON.stringify(backupCodes),
        key: key,
      }),
      twoFactorSecret: symmetricEncrypt({
        data: encodedSecret,
        key: key,
      }),
    },
  });

  if (count === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: TWO_FACTOR_ALREADY_ENABLED_MESSAGE,
      userMessage: TWO_FACTOR_ALREADY_ENABLED_MESSAGE,
      statusCode: 400,
    });
  }

  return {
    secret: encodedSecret,
    uri,
  };
};
