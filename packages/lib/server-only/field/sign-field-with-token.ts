import { checkFieldValue, representationForVersion } from '@documenso/lib/advanced-fields-validation/field-value-rules';
import { isRequiredField } from '@documenso/lib/utils/advanced-fields-helpers';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { match } from 'ts-pattern';

import { DEFAULT_DOCUMENT_DATE_FORMAT } from '../../constants/date-formats';
import { DEFAULT_DOCUMENT_TIME_ZONE } from '../../constants/time-zones';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { TRecipientActionAuth } from '../../types/document-auth';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { getRecipientFieldsWhereInput } from '../../utils/recipient-queries';
import { assertRecipientNotExpired } from '../../utils/recipients';
import { validateFieldAuth } from '../document/validate-field-auth';
import { assertSenderNotDisabled } from '../user/assert-user-not-disabled';
import { lockEnvelopeForFieldWrite } from './lock-field-write';

/**
 * Solid Ten Sign (A-3): a value the field's own rules refuse (over the character limit, out of
 * the number range, not one of the options, a missing or typed signature where not allowed) is
 * the signer's input: a 400 with the reason, not a 500.
 */
const fieldValueRefused = (message: string) =>
  new AppError(AppErrorCode.INVALID_BODY, { message, userMessage: message });

export type SignFieldWithTokenOptions = {
  token: string;
  fieldId: number;
  value: string;
  isBase64?: boolean;
  userId?: number;
  authOptions?: TRecipientActionAuth;
  requestMetadata?: RequestMetadata;
};

/**
 * Please read.
 *
 * Content within this function has been duplicated in the
 * createDocumentFromDirectTemplate file.
 *
 * Any update to this should be reflected in the other file if required.
 *
 * Todo: Extract common logic.
 */
export const signFieldWithToken = async ({
  token,
  fieldId,
  value,
  isBase64,
  userId,
  authOptions,
  requestMetadata,
}: SignFieldWithTokenOptions) => {
  // Solid Ten Sign (L-3): an unknown link or a field this link does not own is a 404, not a raw
  // database error (500).
  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
    },
  });

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Recipient not found', userMessage: 'Recipient not found' });
  }

  const field = await prisma.field.findFirst({
    where: {
      id: fieldId,
      recipient: getRecipientFieldsWhereInput({
        recipient,
        allowAssistantAccessToOtherRecipients: true,
      }),
    },
    include: {
      envelope: {
        include: {
          recipients: true,
        },
      },
      recipient: true,
    },
  });

  if (!field) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'This field is not part of the document for this link.',
      userMessage: 'This field is not part of the document for this link.',
    });
  }

  const { envelope } = field;

  if (!envelope) {
    throw new Error(`Document not found for field ${field.id}`);
  }

  if (!recipient) {
    throw new Error(`Recipient not found for field ${field.id}`);
  }

  await assertSenderNotDisabled({ userId: envelope.userId });

  if (envelope.deletedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'This document was deleted.',
      userMessage: 'This document was deleted.',
    });
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'This document can no longer be signed.',
      userMessage: 'This document can no longer be signed.',
    });
  }

  assertRecipientNotExpired(recipient);

  if (recipient.signingStatus === SigningStatus.SIGNED || field.recipient.signingStatus === SigningStatus.SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'This document has already been signed with this link.',
      userMessage: 'This document has already been signed with this link.',
    });
  }

  // Solid Ten Sign (L-2): a plain refusal (400), not a 500.
  if (field.inserted) {
    throw new AppError(AppErrorCode.ALREADY_EXISTS, {
      message: 'This field is already filled in. Clear it first to change it.',
      userMessage: 'This field is already filled in. Clear it first to change it.',
    });
  }

  // Unreachable code based on the above query but we need to satisfy TypeScript
  if (field.recipientId === null) {
    throw new Error(`Field ${fieldId} has no recipientId`);
  }

  // Solid Ten: files are attached through their own upload route, on version 2 envelopes.
  if (field.type === FieldType.FILE) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: '"Attach a file" fields cannot be signed here.',
    });
  }

  if (
    field.type === FieldType.SIGNATURE &&
    recipient.role === RecipientRole.ASSISTANT &&
    field.recipientId !== recipient.id
  ) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Assistant recipients cannot sign signature fields',
    });
  }

  const derivedRecipientActionAuth = await validateFieldAuth({
    documentAuthOptions: envelope.authOptions,
    recipient,
    field,
    userId,
    authOptions,
  });

  const documentMeta = await prisma.documentMeta.findFirst({
    where: {
      envelope: {
        id: envelope.id,
      },
    },
  });

  // Solid Ten Sign (L round 2): the one set of value rules every signing route uses
  // (field-value-rules.ts), in the representation this envelope stores.
  const valueCheck = checkFieldValue({
    field,
    value,
    representation: representationForVersion(envelope.internalVersion),
    isRequired: isRequiredField(field),
    isBase64,
    typedSignatureEnabled: documentMeta?.typedSignatureEnabled,
  });

  if (valueCheck.result === 'refused') {
    throw fieldValueRefused(valueCheck.reason);
  }

  const isSignatureField = field.type === FieldType.SIGNATURE || field.type === FieldType.FREE_SIGNATURE;

  let customText = !isSignatureField ? value : undefined;

  const signatureImageAsBase64 = isSignatureField && isBase64 ? value : undefined;
  const typedSignature = isSignatureField && !isBase64 ? value : undefined;

  if (field.type === FieldType.DATE) {
    customText = DateTime.now()
      .setZone(documentMeta?.timezone ?? DEFAULT_DOCUMENT_TIME_ZONE)
      .toFormat(documentMeta?.dateFormat ?? DEFAULT_DOCUMENT_DATE_FORMAT);
  }

  const assistant = recipient.role === RecipientRole.ASSISTANT ? recipient : undefined;

  return await prisma.$transaction(async (tx) => {
    // Solid Ten Sign (AUD-C2): under the envelope lock, both recipients must still be NOT_SIGNED.
    await lockEnvelopeForFieldWrite(tx, { envelopeId: envelope.id, recipientIds: [recipient.id, field.recipientId] });

    const updatedField = await tx.field.update({
      where: {
        id: field.id,
      },
      data: {
        customText,
        inserted: true,
      },
    });

    if (isSignatureField) {
      const signature = await tx.signature.upsert({
        where: {
          fieldId: field.id,
        },
        create: {
          fieldId: field.id,
          recipientId: field.recipientId,
          signatureImageAsBase64: signatureImageAsBase64,
          typedSignature: typedSignature,
        },
        update: {
          signatureImageAsBase64: signatureImageAsBase64,
          typedSignature: typedSignature,
        },
      });

      // Dirty but I don't want to deal with type information
      Object.assign(updatedField, {
        signature,
      });
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type:
          assistant && field.recipientId !== assistant.id
            ? DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_PREFILLED
            : DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
        envelopeId: envelope.id,
        user: {
          email: assistant?.email ?? recipient.email,
          name: assistant?.name ?? recipient.name,
        },
        requestMetadata,
        data: {
          recipientEmail: recipient.email,
          recipientId: recipient.id,
          recipientName: recipient.name,
          recipientRole: recipient.role,
          fieldId: updatedField.secondaryId,
          field: match(updatedField.type)
            .with(FieldType.SIGNATURE, FieldType.FREE_SIGNATURE, (type) => ({
              type,
              data: signatureImageAsBase64 || typedSignature || '',
            }))
            .with(FieldType.DATE, FieldType.EMAIL, FieldType.NAME, FieldType.TEXT, FieldType.INITIALS, (type) => ({
              type,
              data: updatedField.customText,
            }))
            .with(FieldType.NUMBER, FieldType.RADIO, FieldType.CHECKBOX, FieldType.DROPDOWN, (type) => ({
              type,
              data: updatedField.customText,
            }))
            .with(FieldType.FILE, (type) => ({ type, data: updatedField.customText }))
            .exhaustive(),
          fieldSecurity: derivedRecipientActionAuth
            ? {
                type: derivedRecipientActionAuth,
              }
            : undefined,
        },
      }),
    });

    return updatedField;
  });
};
