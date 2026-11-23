import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TRecipientAccessAuthTypes } from '@documenso/lib/types/document-auth';
import { type TRecipientActionAuthTypes, ZRecipientAuthOptionsSchema } from '@documenso/lib/types/document-auth';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData, diffRecipientChanges } from '@documenso/lib/utils/document-audit-logs';
import { createRecipientAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { extractLegacyIds } from '../../universal/id';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapFieldToLegacyField } from '../../utils/fields';
import { canRecipientBeModified } from '../../utils/recipients';
import { assertPasswordActionAuthAllowed } from '../auth/assert-password-action-auth';
import { assertEnvelopeMutable } from '../envelope/assert-envelope-mutable';
import { lockEnvelopeForRecipientChange } from '../envelope/envelope-transition-lock';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { prepareRecipientEmailChanges } from '../recipient-reassign/recipient-email-change';
import { assertCompatibleRecipientGrouping } from '../signature-level/assert-compatible-recipient-grouping';
import { assertCompatibleRecipientRole } from '../signature-level/assert-compatible-recipient-role';
import { assertAssistantRolesAllowedOnEnvelope } from './assert-assistant-signing-order';

export interface UpdateEnvelopeRecipientsOptions {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;
  recipients: {
    id: number;
    email?: string;
    name?: string;
    role?: RecipientRole;
    signingOrder?: number | null;
    accessAuth?: TRecipientAccessAuthTypes[];
    actionAuth?: TRecipientActionAuthTypes[];
  }[];
  requestMetadata: ApiRequestMetadata;
}

export const updateEnvelopeRecipients = async ({
  userId,
  teamId,
  id,
  recipients,
  requestMetadata,
}: UpdateEnvelopeRecipientsOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: null,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      fields: true,
      recipients: true,
      team: {
        select: {
          organisation: {
            select: {
              organisationClaim: true,
            },
          },
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope not found',
    });
  }

  assertEnvelopeMutable(envelope);

  if (envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Envelope already complete',
    });
  }

  // Solid Ten Sign (AUD-C12): an assistant needs sequential signing.
  await assertAssistantRolesAllowedOnEnvelope({
    envelopeId: envelope.id,
    roles: recipients.map((recipient) => recipient.role),
  });

  const recipientsHaveActionAuth = recipients.some(
    (recipient) => recipient.actionAuth && recipient.actionAuth.length > 0,
  );

  // Check if user has permission to set the global action auth.
  if (recipientsHaveActionAuth && !envelope.team.organisation.organisationClaim.flags.cfr21) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'You do not have permission to set the action auth',
    });
  }

  for (const recipient of recipients) {
    if (recipient.role === undefined) {
      continue;
    }

    assertCompatibleRecipientRole({
      signatureLevel: envelope.signatureLevel,
      role: recipient.role,
    });
  }

  const orderUpdates = recipients.flatMap((update) => {
    const existingRecipient = envelope.recipients.find((recipient) => recipient.id === update.id);

    if (!existingRecipient || update.signingOrder === undefined) {
      return [];
    }

    return [{ ...existingRecipient, ...update }];
  });

  const orderUpdateIds = new Set(orderUpdates.map((recipient) => recipient.id));

  assertCompatibleRecipientGrouping({
    signatureLevel: envelope.signatureLevel,
    recipients: orderUpdates,
    existingRecipients: envelope.recipients.filter((recipient) => !orderUpdateIds.has(recipient.id)),
  });

  const recipientsToUpdate = recipients.map((recipient) => {
    const originalRecipient = envelope.recipients.find((existingRecipient) => existingRecipient.id === recipient.id);

    if (!originalRecipient) {
      throw plainRefusal(
        AppErrorCode.NOT_FOUND,
        'This document changed while you were editing it. Reload the page and try again.',
        { recipientId: recipient.id },
      );
    }

    if (!canRecipientBeModified(originalRecipient, envelope.fields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot modify a recipient who has already interacted with the document',
      });
    }

    return {
      originalRecipient,
      updateData: recipient,
    };
  });

  const emailChanges = await prepareRecipientEmailChanges({
    envelope,
    changes: recipientsToUpdate.map(({ originalRecipient, updateData }) => ({
      previous: originalRecipient,
      newEmail: updateData.email ?? originalRecipient.email,
    })),
    resultingRecipients: envelope.recipients.map((existing) => ({
      id: existing.id,
      email: recipients.find((update) => update.id === existing.id)?.email ?? existing.email,
    })),
  });

  const updatedRecipients = await prisma.$transaction(async (tx) => {
    await assertEnvelopeMutable(envelope, tx);

    // Solid Ten Sign (FS2-C1): lock, and refuse when a recipient being edited signed, declined
    // or got a new link since it was read.
    await lockEnvelopeForRecipientChange(
      tx,
      envelope.id,
      recipientsToUpdate.map(({ originalRecipient }) => originalRecipient),
    );

    return await Promise.all(
      recipientsToUpdate.map(async ({ originalRecipient, updateData }) => {
        let authOptions = ZRecipientAuthOptionsSchema.parse(originalRecipient.authOptions);

        if (updateData.actionAuth !== undefined || updateData.accessAuth !== undefined) {
          // Solid Ten Sign (N-5): a stored "Require password" may stay; a new one is refused.
          assertPasswordActionAuthAllowed(updateData.actionAuth, authOptions.actionAuth);

          authOptions = createRecipientAuthOptions({
            accessAuth: updateData.accessAuth || authOptions.accessAuth,
            actionAuth: updateData.actionAuth || authOptions.actionAuth,
          });
        }

        const mergedRecipient = {
          ...originalRecipient,
          ...updateData,
        };

        const updatedRecipient = await tx.recipient.update({
          where: {
            id: originalRecipient.id,
            envelopeId: envelope.id,
          },
          data: {
            name: mergedRecipient.name,
            email: mergedRecipient.email.toLowerCase(),
            role: mergedRecipient.role,
            signingOrder: mergedRecipient.signingOrder,
            envelopeId: envelope.id,
            sendStatus: mergedRecipient.role === RecipientRole.CC ? SendStatus.SENT : SendStatus.NOT_SENT,
            signingStatus: mergedRecipient.role === RecipientRole.CC ? SigningStatus.SIGNED : SigningStatus.NOT_SIGNED,
            authOptions,
            ...emailChanges.resetDataFor(originalRecipient.id),
          },
          include: {
            fields: true,
          },
        });

        await emailChanges.recordAudit(tx, updatedRecipient, requestMetadata);

        // Clear all fields if the recipient role is changed to a type that cannot have fields.
        if (
          originalRecipient.role !== updatedRecipient.role &&
          (updatedRecipient.role === RecipientRole.CC || updatedRecipient.role === RecipientRole.VIEWER)
        ) {
          await tx.field.deleteMany({
            where: {
              recipientId: updatedRecipient.id,
            },
          });
        }

        // Handle recipient updated audit log.
        if (envelope.type === EnvelopeType.DOCUMENT) {
          const changes = diffRecipientChanges(originalRecipient, updatedRecipient);

          if (changes.length > 0) {
            await tx.documentAuditLog.create({
              data: createDocumentAuditLogData({
                type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
                envelopeId: envelope.id,
                metadata: requestMetadata,
                data: {
                  recipientEmail: updatedRecipient.email,
                  recipientName: updatedRecipient.name,
                  recipientId: updatedRecipient.id,
                  recipientRole: updatedRecipient.role,
                  changes,
                },
              }),
            });
          }
        }

        return updatedRecipient;
      }),
    );
  });

  await emailChanges.notify(requestMetadata);

  return {
    recipients: updatedRecipients.map((recipient) => ({
      ...recipient,
      ...extractLegacyIds(envelope),
      fields: recipient.fields.map((field) => mapFieldToLegacyField(field, envelope)),
    })),
  };
};
