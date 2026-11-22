import { getFieldFileMaxBytes } from '@documenso/lib/constants/field-file';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { listEnvelopeFieldFiles, listSignerFieldFiles } from '@documenso/lib/server-only/field-file/field-file-access';
import { fieldFileRemoveRateLimit, fieldFileUploadRateLimit } from '@documenso/lib/server-only/field-file/rate-limits';
import { removeFieldFile } from '@documenso/lib/server-only/field-file/remove-field-file';
import { uploadFieldFile } from '@documenso/lib/server-only/field-file/upload-field-file';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure, procedure, router } from '../trpc';
import {
  ZListEnvelopeFieldFilesRequestSchema,
  ZListEnvelopeFieldFilesResponseSchema,
  ZListSignerFieldFilesRequestSchema,
  ZListSignerFieldFilesResponseSchema,
  ZRemoveFieldFileRequestSchema,
  ZRemoveFieldFileResponseSchema,
  ZUploadFieldFileRequestSchema,
  ZUploadFieldFileResponseSchema,
} from './schema';

/**
 * Rate limits are keyed by IP and by the link token's recipient, so one link cannot
 * flood the store from many addresses, nor one address from many links.
 */
const assertFieldFileRateLimit = async (
  limiter: typeof fieldFileUploadRateLimit,
  { token, ip, count }: { token: string; ip: string; count?: number },
) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: { id: true, envelopeId: true },
  });

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'This signing link is no longer valid.' });
  }

  const result = await limiter.check({ ip, identifier: `${recipient.envelopeId}:${recipient.id}`, count });

  if (result.isLimited) {
    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: 'Too many file changes. Try again later.',
    });
  }
};

export const fieldFileRouter = router({
  /**
   * NOTE: PUBLIC PROCEDURE. The signing link token authorizes it.
   */
  upload: procedure
    .input(ZUploadFieldFileRequestSchema)
    .output(ZUploadFieldFileResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { payload, file } = input;

      ctx.logger.info({ input: { fieldId: payload.fieldId } });

      await assertFieldFileRateLimit(fieldFileUploadRateLimit, {
        token: payload.token,
        ip: ctx.metadata.requestMetadata.ipAddress ?? 'unknown',
      });

      const { upload, signedField, affectedFields } = await uploadFieldFile({
        token: payload.token,
        fieldId: payload.fieldId,
        replaceFileId: payload.replaceFileId,
        file,
        requestMetadata: ctx.metadata.requestMetadata,
      });

      return { file: upload, signedField, affectedFields };
    }),

  /**
   * NOTE: PUBLIC PROCEDURE. The signing link token authorizes it.
   */
  remove: procedure
    .input(ZRemoveFieldFileRequestSchema)
    .output(ZRemoveFieldFileResponseSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.logger.info({ input: { fieldId: input.fieldId, fileId: input.fileId } });

      await assertFieldFileRateLimit(fieldFileRemoveRateLimit, {
        token: input.token,
        ip: ctx.metadata.requestMetadata.ipAddress ?? 'unknown',
      });

      return await removeFieldFile({
        token: input.token,
        fieldId: input.fieldId,
        fileId: input.fileId,
        requestMetadata: ctx.metadata.requestMetadata,
      });
    }),

  /**
   * NOTE: PUBLIC PROCEDURE. Lists only what the token may see.
   */
  listForSigner: procedure
    .input(ZListSignerFieldFilesRequestSchema)
    .output(ZListSignerFieldFilesResponseSchema)
    .query(async ({ input }) => {
      return {
        files: await listSignerFieldFiles({ token: input.token }),
        maxFileBytes: getFieldFileMaxBytes(),
      };
    }),

  listForEnvelope: authenticatedProcedure
    .input(ZListEnvelopeFieldFilesRequestSchema)
    .output(ZListEnvelopeFieldFilesResponseSchema)
    .query(async ({ input, ctx }) => {
      return {
        files: await listEnvelopeFieldFiles({ userId: ctx.user.id, envelopeId: input.envelopeId }),
      };
    }),
});
