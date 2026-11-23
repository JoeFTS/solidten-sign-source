import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import { describeFieldForUserAtStart } from '@documenso/lib/utils/describe-field';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, type Prisma, SigningStatus } from '@prisma/client';
import { IS_FILE_UPLOAD_ENABLED } from '../../constants/field-file';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZFileFieldMeta } from '../../types/field-meta';
import { isTspEnvelope } from '../../types/signature-level';
import { toFieldFileCustomText } from '../../utils/field-file';
import { assertRecipientNotExpired } from '../../utils/recipients';
import { assertFieldSignableByLogic } from '../field-logic/apply-field-logic';
import { assertSenderNotDisabled } from '../user/assert-user-not-disabled';

/**
 * The file meta of a field, with safe defaults when the stored meta is missing or bad.
 */
export const readFileFieldMeta = (fieldMeta: unknown) => {
  const parsed = ZFileFieldMeta.safeParse(fieldMeta);

  return parsed.success ? parsed.data : { type: 'file' as const };
};

/**
 * Load the field a signer wants to attach a file to, or remove a file from, and check
 * that the signer may change it now. The link token is the only credential.
 *
 * Only the recipient that owns the field can change its files: an assistant cannot
 * attach files for someone else.
 */
export const getSignerFileFieldContext = async ({ token, fieldId }: { token: string; fieldId: number }) => {
  if (!IS_FILE_UPLOAD_ENABLED()) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'File upload is turned off on this server.',
    });
  }

  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
    },
  });

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'This signing link is no longer valid.',
    });
  }

  const field = await prisma.field.findFirst({
    where: {
      id: fieldId,
      recipientId: recipient.id,
      envelopeId: recipient.envelopeId,
    },
    include: {
      envelope: {
        select: {
          id: true,
          userId: true,
          teamId: true,
          status: true,
          deletedAt: true,
          internalVersion: true,
          signatureLevel: true,
        },
      },
    },
  });

  if (!field) {
    throw plainRefusal(AppErrorCode.NOT_FOUND, 'This field is not part of this document any more. Reload the page.', {
      fieldId,
    });
  }

  if (field.type !== FieldType.FILE) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'This field does not take files.',
    });
  }

  const { envelope } = field;

  await assertSenderNotDisabled({ userId: envelope.userId });

  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'File upload needs a version 2 envelope.',
    });
  }

  if (isTspEnvelope(envelope)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'File upload cannot be used with advanced or qualified signatures.',
    });
  }

  if (envelope.deletedAt) {
    throw plainRefusal(AppErrorCode.INVALID_REQUEST, 'This document was deleted.', { envelopeId: envelope.id });
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'The document is no longer open for signing, so its files cannot change.',
    });
  }

  assertRecipientNotExpired(recipient);

  // Files freeze once the signer completes.
  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'You have already completed this document, so its files cannot change.',
    });
  }

  const fileMeta = readFileFieldMeta(field.fieldMeta);

  if (fileMeta.readOnly) {
    throw plainRefusal(AppErrorCode.INVALID_REQUEST, `${describeFieldForUserAtStart(field)} is read-only.`, {
      fieldId,
    });
  }

  await assertFieldSignableByLogic({ tx: prisma, field });

  return { recipient, field, envelope, fileMeta };
};

/**
 * Lock the envelope row for the rest of the transaction, so two uploads cannot both pass
 * the file count or the envelope byte cap, and re-read the states that freeze files.
 */
export const lockFileEnvelope = async (
  tx: Prisma.TransactionClient,
  { envelopeId, recipientId }: { envelopeId: string; recipientId: number },
) => {
  await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR UPDATE`;

  const [envelope, recipient] = await Promise.all([
    tx.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { status: true, deletedAt: true } }),
    tx.recipient.findUniqueOrThrow({ where: { id: recipientId }, select: { signingStatus: true } }),
  ]);

  if (envelope.status !== DocumentStatus.PENDING || envelope.deletedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'The document is no longer open for signing, so its files cannot change.',
    });
  }

  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'You have already completed this document, so its files cannot change.',
    });
  }
};

/**
 * Bring the field's stored value in line with its files: the names, in upload order, and
 * inserted when there is at least one.
 */
export const syncFileFieldValue = async (tx: Prisma.TransactionClient, fieldId: number) => {
  const uploads = await tx.fieldFileUpload.findMany({
    where: { fieldId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { fileName: true },
  });

  return await tx.field.update({
    where: { id: fieldId },
    data: {
      customText: toFieldFileCustomText(uploads.map((upload) => upload.fileName)),
      inserted: uploads.length > 0,
    },
  });
};
