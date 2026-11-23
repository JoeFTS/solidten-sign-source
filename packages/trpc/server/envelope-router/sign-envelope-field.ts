import { checkFieldValue } from '@documenso/lib/advanced-fields-validation/field-value-rules';
import { isBase64Image } from '@documenso/lib/constants/signatures';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import { assertActionAuthActorIsRecipient } from '@documenso/lib/server-only/document/assert-completion-actor';
import { validateFieldAuth } from '@documenso/lib/server-only/document/validate-field-auth';
import { lockEnvelopeForFieldWrite } from '@documenso/lib/server-only/field/lock-field-write';
import { deleteRemovedFieldFiles } from '@documenso/lib/server-only/field-file/remove-field-files-in-transaction';
import { applyFieldLogic, assertFieldSignableByLogic } from '@documenso/lib/server-only/field-logic/apply-field-logic';
import { findInPersonHostForRequest } from '@documenso/lib/server-only/in-person/in-person-session';
import { assertSenderNotDisabled } from '@documenso/lib/server-only/user/assert-user-not-disabled';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { isRequiredField } from '@documenso/lib/utils/advanced-fields-helpers';
import { describeFieldForUserAtStart } from '@documenso/lib/utils/describe-field';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import { getRecipientFieldsWhereInput } from '@documenso/lib/utils/recipient-queries';
import { assertRecipientNotExpired } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { match } from 'ts-pattern';
import { procedure } from '../trpc';
import {
  type TSignEnvelopeFieldValue,
  ZSignEnvelopeFieldRequestSchema,
  ZSignEnvelopeFieldResponseSchema,
} from './sign-envelope-field.types';

// Note that this is an unauthenticated public procedure route.
export const signEnvelopeFieldRoute = procedure
  .input(ZSignEnvelopeFieldRequestSchema)
  .output(ZSignEnvelopeFieldResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, metadata } = ctx;
    const { token, fieldId, fieldValue, authOptions } = input;

    ctx.logger.info({
      input: {
        fieldId,
      },
    });

    const recipient = await prisma.recipient.findFirst({
      where: {
        token,
      },
    });

    if (!recipient) {
      throw new AppError(AppErrorCode.NOT_FOUND);
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
            documentMeta: true,
          },
        },
        recipient: true,
      },
    });

    if (!field) {
      throw plainRefusal(AppErrorCode.NOT_FOUND, 'This field is not part of this document any more. Reload the page.', {
        fieldId,
      });
    }

    const { envelope } = field;
    const { documentMeta } = envelope;

    await assertSenderNotDisabled({ userId: envelope.userId });

    if (envelope.internalVersion !== 2) {
      throw plainRefusal(
        AppErrorCode.NOT_FOUND,
        'This document cannot be signed on this page. Open the link from your email again.',
        { envelopeId: envelope.id },
      );
    }

    if (
      field.type === FieldType.SIGNATURE &&
      recipient.id !== field.recipientId &&
      recipient.role === RecipientRole.ASSISTANT
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Assistant recipients cannot sign signature fields`,
      });
    }

    if (envelope.deletedAt) {
      throw plainRefusal(AppErrorCode.INVALID_REQUEST, 'This document was deleted.', { envelopeId: envelope.id });
    }

    if (envelope.status !== DocumentStatus.PENDING) {
      throw plainRefusal(AppErrorCode.INVALID_REQUEST, 'This document can no longer be signed.', {
        envelopeId: envelope.id,
        status: envelope.status,
      });
    }

    // Solid Ten Sign (O-F4): after the document checks, so a field of a completed or deleted
    // document gets that reason; and it names the field.
    if (fieldValue.type !== field.type) {
      throw plainRefusal(
        AppErrorCode.INVALID_BODY,
        `${describeFieldForUserAtStart(field)} is a ${field.type.toLowerCase().replace(/_/g, ' ')} field and cannot take this value.`,
        { fieldId, fieldType: field.type, valueType: fieldValue.type },
      );
    }

    // Both are checked because an assistant may insert values into a field belonging to
    // another recipient, and neither signing window may have closed. For every other
    // role these reference the same recipient.
    assertRecipientNotExpired(recipient);
    assertRecipientNotExpired(field.recipient);

    if (recipient.signingStatus === SigningStatus.SIGNED || field.recipient.signingStatus === SigningStatus.SIGNED) {
      throw plainRefusal(AppErrorCode.INVALID_REQUEST, 'You have already signed this document.', {
        recipientId: recipient.id,
      });
    }

    if (field.fieldMeta?.readOnly) {
      throw plainRefusal(AppErrorCode.INVALID_REQUEST, `${describeFieldForUserAtStart(field)} is read-only.`, {
        fieldId,
      });
    }

    // Unreachable code based on the above query but we need to satisfy TypeScript
    if (field.recipientId === null) {
      throw new Error(`Field ${fieldId} has no recipientId`); // internal, never a user-facing refusal
    }

    const fieldRecipientId = field.recipientId;

    await assertFieldSignableByLogic({ tx: prisma, field });

    const insertionValues = extractFieldInsertionValues({ fieldValue, field, documentMeta });

    // Solid Ten Sign (L round 2): the one set of value rules every signing route uses, on the
    // value as this envelope stores it (option indexes). Uninserting is not a value.
    if (insertionValues.inserted) {
      const valueCheck = checkFieldValue({
        field,
        value: toRuleValue(fieldValue),
        representation: 'option-index',
        isRequired: isRequiredField(field),
        isBase64:
          fieldValue.type === FieldType.SIGNATURE && Boolean(fieldValue.value && isBase64Image(fieldValue.value)),
        typedSignatureEnabled: documentMeta?.typedSignatureEnabled,
      });

      if (valueCheck.result === 'refused') {
        throw new AppError(AppErrorCode.INVALID_BODY, { message: valueCheck.reason, userMessage: valueCheck.reason });
      }
    }

    // Early return for uninserting fields.
    if (!insertionValues.inserted) {
      // Solid Ten Sign (AUD-C11 follow-up): with action auth, only the recipient's own session
      // un-signs. On a host's in-person device the signed-in user is the host, as below.
      const isInPersonUnsign = Boolean(
        await findInPersonHostForRequest({ authSessionId: ctx.inPersonLock?.session.id ?? ctx.session?.id, token }),
      );

      await assertActionAuthActorIsRecipient({
        documentAuth: envelope.authOptions,
        recipient,
        userId: isInPersonUnsign ? undefined : user?.id,
      });

      const unsignedResult = await prisma.$transaction(async (tx) => {
        // Solid Ten Sign (AUD-C2): under the envelope lock, both recipients must still be NOT_SIGNED.
        await lockEnvelopeForFieldWrite(tx, {
          envelopeId: envelope.id,
          recipientIds: [recipient.id, fieldRecipientId],
        });

        const updatedField = await tx.field.update({
          where: {
            id: field.id,
          },
          data: {
            customText: '',
            inserted: false,
          },
        });

        await tx.signature.deleteMany({
          where: {
            fieldId: field.id,
          },
        });

        if (recipient.role !== RecipientRole.ASSISTANT) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
              envelopeId: envelope.id,
              user: {
                name: recipient.name,
                email: recipient.email,
              },
              requestMetadata: metadata.requestMetadata,
              data: {
                field: field.type,
                fieldId: field.secondaryId,
              },
            }),
          });
        }

        const { changedFields, removedFileObjects } = await applyFieldLogic({
          tx,
          envelopeId: envelope.id,
          recipientId: field.recipientId,
          user: recipient,
          requestMetadata: metadata.requestMetadata,
        });

        return {
          signedField: updatedField,
          affectedFields: changedFields,
          removedFileObjects,
        };
      });

      return await deleteRemovedFieldFiles(unsignedResult);
    }

    // Solid Ten Sign: on a host's in-person device the signed-in user is the host, never the signer.
    const isInPersonTurn = Boolean(
      await findInPersonHostForRequest({ authSessionId: ctx.inPersonLock?.session.id ?? ctx.session?.id, token }),
    );

    const derivedRecipientActionAuth = await validateFieldAuth({
      documentAuthOptions: envelope.authOptions,
      recipient,
      field,
      userId: isInPersonTurn ? undefined : user?.id,
      authOptions,
    });

    const assistant = recipient.role === RecipientRole.ASSISTANT ? recipient : undefined;

    let signatureImageAsBase64 = null;
    let typedSignature = null;

    if (field.type === FieldType.SIGNATURE) {
      if (fieldValue.type !== FieldType.SIGNATURE) {
        throw plainRefusal(AppErrorCode.INVALID_REQUEST, `${describeFieldForUserAtStart(field)} takes a signature.`, {
          fieldId,
        });
      }

      if (fieldValue.value) {
        const isBase64 = isBase64Image(fieldValue.value);

        signatureImageAsBase64 = isBase64 ? fieldValue.value : null;
        typedSignature = !isBase64 ? fieldValue.value : null;
      }
    }

    const signedResult = await prisma.$transaction(async (tx) => {
      // Solid Ten Sign (AUD-C2): under the envelope lock, both recipients must still be NOT_SIGNED.
      await lockEnvelopeForFieldWrite(tx, { envelopeId: envelope.id, recipientIds: [recipient.id, fieldRecipientId] });

      const updatedField = await tx.field.update({
        where: {
          id: field.id,
        },
        data: {
          customText: insertionValues.customText,
          inserted: insertionValues.inserted,
        },
        include: {
          signature: true,
        },
      });

      if (field.type === FieldType.SIGNATURE) {
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
          requestMetadata: metadata.requestMetadata,
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

      const { changedFields, removedFileObjects } = await applyFieldLogic({
        tx,
        envelopeId: envelope.id,
        recipientId: field.recipientId,
        user: assistant ?? recipient,
        requestMetadata: metadata.requestMetadata,
      });

      return {
        signedField: updatedField,
        affectedFields: changedFields,
        removedFileObjects,
      };
    });

    return await deleteRemovedFieldFiles(signedResult);
  });

/** A version-2 field value as the one string the value rules take (field-value-rules.ts). */
const toRuleValue = (fieldValue: TSignEnvelopeFieldValue): string | null =>
  match(fieldValue)
    .with({ type: FieldType.CHECKBOX }, ({ value }) => JSON.stringify(value))
    .with({ type: FieldType.RADIO }, ({ value }) => (value === null ? null : String(value)))
    .with({ type: FieldType.DATE }, ({ value }) => (value ? 'date' : null))
    .otherwise(({ value }) => (typeof value === 'string' ? value : null));
