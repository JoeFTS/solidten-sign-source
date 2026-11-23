import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';
import { z } from 'zod';

import { authenticatedProcedure } from '../trpc';

/**
 * Solid Ten Sign (L-4): why a signing request to this recipient was not delivered: LIMIT (the
 * organisation's email limit stopped it, K-2) or DELIVERY (the mail server refused it on every
 * attempt). From the latest EMAIL_NOT_DELIVERED entry. Same access as the document page.
 */
export const getDeliveryFailureRoute = authenticatedProcedure
  .input(z.object({ envelopeId: z.string(), recipientId: z.number() }))
  .output(z.object({ reason: z.enum(['LIMIT', 'DELIVERY']) }))
  .query(async ({ input, ctx }) => {
    const { envelopeWhereInput } = await getEnvelopeWhereInput({
      id: { type: 'envelopeId', id: input.envelopeId },
      type: EnvelopeType.DOCUMENT,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });

    const envelope = await prisma.envelope.findFirst({ where: envelopeWhereInput, select: { id: true } });

    if (!envelope) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Document not found' });
    }

    const entry = await prisma.documentAuditLog.findFirst({
      where: {
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_NOT_DELIVERED,
        AND: [
          { data: { path: ['recipientId'], equals: input.recipientId } },
          { data: { path: ['emailType'], equals: 'SIGNING_REQUEST' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { data: true },
    });

    const reason = (entry?.data as { reason?: unknown } | undefined)?.reason;

    return { reason: reason === 'LIMIT' ? 'LIMIT' : 'DELIVERY' };
  });
