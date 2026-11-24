import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TRecipientAccessAuthTypes } from '@documenso/lib/types/document-auth';
import { type TRecipientActionAuthTypes, ZRecipientAuthOptionsSchema } from '@documenso/lib/types/document-auth';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { nanoid } from '@documenso/lib/universal/id';
import { createDocumentAuditLogData, diffRecipientChanges } from '@documenso/lib/utils/document-audit-logs';
import { createRecipientAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import type { Recipient } from '@prisma/client';
import { EnvelopeType, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';
import { isDeepEqual } from 'remeda';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { type EnvelopeIdOptions, mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { canSendMailToRecipient } from '../../utils/recipient-mail';
import { canRecipientBeModified } from '../../utils/recipients';
import { assertActionAuthAllowed } from '../auth/assert-action-auth-allowed';
import { assertEnvelopeMutable } from '../envelope/assert-envelope-mutable';
import { lockEnvelopeForRecipientChange } from '../envelope/envelope-transition-lock';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { prepareRecipientEmailChanges } from '../recipient-reassign/recipient-email-change';
import { assertCompatibleRecipientGrouping } from '../signature-level/assert-compatible-recipient-grouping';
import { assertCompatibleRecipientRole } from '../signature-level/assert-compatible-recipient-role';
import { assertAssistantRolesAllowedOnEnvelope } from './assert-assistant-signing-order';
import { assertNewRecipientEmailsAvailable } from './assert-new-recipient-emails';
import { assertRecipientChangeAllowed, keepsRecipientStatus } from './assert-recipient-change-allowed';
import { resolveReplacedRecipientSigningOrders } from './assign-omitted-recipient-signing-orders';

export interface SetDocumentRecipientsOptions {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;
  recipients: RecipientData[];
  requestMetadata: ApiRequestMetadata;
}

export const setDocumentRecipients = async ({
  userId,
  teamId,
  id,
  recipients,
  requestMetadata,
}: SetDocumentRecipientsOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      fields: true,
      documentMeta: true,
      team: {
        select: {
          organisation: {
            select: {
              organisationClaim: true,
            },
          },
        },
      },
      recipients: true,
    },
  });

  const user = await prisma.user.findFirstOrThrow({
    where: {
      id: userId,
    },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  assertEnvelopeMutable(envelope);

  if (envelope.completedAt) {
    throw new Error('Document already complete');
  }

  // Solid Ten Sign (AUD-C12): an assistant needs sequential signing.
  await assertAssistantRolesAllowedOnEnvelope({
    envelopeId: envelope.id,
    roles: recipients.map((recipient) => recipient.role),
  });

  for (const recipient of recipients) {
    assertCompatibleRecipientRole({
      signatureLevel: envelope.signatureLevel,
      role: recipient.role,
    });
  }

  const existingRecipients = envelope.recipients;

  const { recipients: normalizedRecipients, requestedOrderRecipients } = resolveReplacedRecipientSigningOrders({
    recipients: recipients.map((recipient) => ({
      ...recipient,
      email: recipient.email.toLowerCase(),
    })),
    existingRecipients,
  });

  assertCompatibleRecipientGrouping({
    signatureLevel: envelope.signatureLevel,
    recipients: requestedOrderRecipients,
    existingRecipients: normalizedRecipients.filter((recipient) => !requestedOrderRecipients.includes(recipient)),
  });

  // Solid Ten Sign (RT2-L1): no new recipient with an email already on a sent document.
  assertNewRecipientEmailsAvailable({
    envelope,
    existingIds: existingRecipients.map((recipient) => recipient.id),
    resulting: normalizedRecipients,
  });

  const removedRecipients = existingRecipients.filter(
    (existingRecipient) => !normalizedRecipients.find((recipient) => recipient.id === existingRecipient.id),
  );

  // Solid Ten Sign (R-1): the one recipient-change check. A recipient who completed their part is
  // not removed, and keeps their email and role.
  for (const removed of removedRecipients) {
    assertRecipientChangeAllowed(removed, 'remove');
  }

  for (const recipient of normalizedRecipients) {
    const existing = existingRecipients.find((existingRecipient) => existingRecipient.id === recipient.id);

    if (existing) {
      assertRecipientChangeAllowed(existing, { email: recipient.email, role: recipient.role });
    }
  }

  const linkedRecipients = normalizedRecipients.map((recipient) => {
    const existing = existingRecipients.find((existingRecipient) => existingRecipient.id === recipient.id);

    const canPersistedRecipientBeModified = existing && canRecipientBeModified(existing, envelope.fields);

    if (
      existing &&
      hasRecipientBeenChanged(existing, recipient) &&
      !canRecipientBeModified(existing, envelope.fields)
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot modify a recipient who has already interacted with the document',
      });
    }

    return {
      ...recipient,
      _persisted: existing,
      canPersistedRecipientBeModified,
    };
  });

  const emailChanges = await prepareRecipientEmailChanges({
    envelope,
    changes: linkedRecipients.flatMap((recipient) =>
      recipient._persisted && recipient.canPersistedRecipientBeModified
        ? [{ previous: recipient._persisted, newEmail: recipient.email }]
        : [],
    ),
    resultingRecipients: linkedRecipients.map((recipient) => ({
      id: recipient._persisted?.id,
      email: recipient.email,
    })),
  });

  const persistedRecipients = await prisma.$transaction(async (tx) => {
    await assertEnvelopeMutable(envelope, tx);

    // Solid Ten Sign (FS2-C1): lock, and refuse when a recipient being edited or removed signed,
    // declined or got a new link since it was read.
    await lockEnvelopeForRecipientChange(tx, envelope.id, [
      ...linkedRecipients.flatMap((recipient) =>
        recipient._persisted && recipient.canPersistedRecipientBeModified ? [recipient._persisted] : [],
      ),
      ...removedRecipients,
    ]);

    return await Promise.all(
      linkedRecipients.map(async (recipient) => {
        let authOptions = ZRecipientAuthOptionsSchema.parse(recipient._persisted?.authOptions);

        if (recipient.actionAuth !== undefined || recipient.accessAuth !== undefined) {
          // Solid Ten Sign (O-F2): the one check for action auth; what is stored may stay.
          assertActionAuthAllowed({
            next: recipient.actionAuth,
            previous: authOptions.actionAuth,
            organisationClaim: envelope.team.organisation.organisationClaim,
          });

          authOptions = createRecipientAuthOptions({
            accessAuth: recipient.accessAuth || authOptions.accessAuth,
            actionAuth: recipient.actionAuth || authOptions.actionAuth,
          });
        }

        if (recipient._persisted && !recipient.canPersistedRecipientBeModified) {
          return {
            ...recipient._persisted,
            clientId: recipient.clientId,
          };
        }

        const upsertedRecipient = await tx.recipient.upsert({
          where: {
            id: recipient._persisted?.id ?? -1,
            envelopeId: envelope.id,
          },
          update: {
            name: recipient.name,
            email: recipient.email,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            envelopeId: envelope.id,
            // Solid Ten Sign (Q-4, R-3): an existing recipient keeps its send and signing status
            // unless the email changes or the role moves to or from CC (keepsRecipientStatus).
            // Before: a save of a sent document marked every kept recipient NOT_SENT.
            ...(recipient._persisted && keepsRecipientStatus(recipient._persisted, recipient)
              ? {}
              : {
                  sendStatus: recipient.role === RecipientRole.CC ? SendStatus.SENT : SendStatus.NOT_SENT,
                  signingStatus: recipient.role === RecipientRole.CC ? SigningStatus.SIGNED : SigningStatus.NOT_SIGNED,
                }),
            authOptions,
            ...emailChanges.resetDataFor(recipient._persisted?.id),
          },
          create: {
            name: recipient.name,
            email: recipient.email,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            token: nanoid(),
            envelopeId: envelope.id,
            sendStatus: recipient.role === RecipientRole.CC ? SendStatus.SENT : SendStatus.NOT_SENT,
            signingStatus: recipient.role === RecipientRole.CC ? SigningStatus.SIGNED : SigningStatus.NOT_SIGNED,
            authOptions,
          },
        });

        const recipientId = upsertedRecipient.id;

        if (recipient._persisted) {
          await emailChanges.recordAudit(tx, upsertedRecipient, requestMetadata);
        }

        // Clear all fields if the recipient role is changed to a type that cannot have fields.
        if (
          recipient._persisted &&
          recipient._persisted.role !== recipient.role &&
          (recipient.role === RecipientRole.CC || recipient.role === RecipientRole.VIEWER)
        ) {
          await tx.field.deleteMany({
            where: {
              recipientId,
            },
          });
        }

        const baseAuditLog = {
          recipientEmail: upsertedRecipient.email,
          recipientName: upsertedRecipient.name,
          recipientId,
          recipientRole: upsertedRecipient.role,
        };

        const changes = recipient._persisted ? diffRecipientChanges(recipient._persisted, upsertedRecipient) : [];

        // Handle recipient updated audit log.
        if (recipient._persisted && changes.length > 0) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
              envelopeId: envelope.id,
              metadata: requestMetadata,
              data: {
                changes,
                ...baseAuditLog,
              },
            }),
          });
        }

        // Handle recipient created audit log.
        if (!recipient._persisted) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_CREATED,
              envelopeId: envelope.id,
              metadata: requestMetadata,
              data: {
                ...baseAuditLog,
                accessAuth: recipient.accessAuth || [],
                actionAuth: recipient.actionAuth || [],
              },
            }),
          });
        }

        return {
          ...upsertedRecipient,
          clientId: recipient.clientId,
        };
      }),
    );
  });

  await emailChanges.notify(requestMetadata);

  if (removedRecipients.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.recipient.deleteMany({
        where: {
          id: {
            in: removedRecipients.map((recipient) => recipient.id),
          },
        },
      });

      await tx.documentAuditLog.createMany({
        data: removedRecipients.map((recipient) =>
          createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_DELETED,
            envelopeId: envelope.id,
            metadata: requestMetadata,
            data: {
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientId: recipient.id,
              recipientRole: recipient.role,
            },
          }),
        ),
      });
    });

    const isRecipientRemovedEmailEnabled = extractDerivedDocumentEmailSettings(envelope.documentMeta).recipientRemoved;

    if (isRecipientRemovedEmailEnabled) {
      await Promise.all(
        removedRecipients.map(async (recipient) => {
          if (
            recipient.sendStatus !== SendStatus.SENT ||
            recipient.role === RecipientRole.CC ||
            !canSendMailToRecipient(recipient)
          ) {
            return;
          }

          await jobs.triggerJob({
            name: 'send.recipient.removed.email',
            payload: {
              envelopeId: envelope.id,
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              inviterName: user.name || undefined,
            },
          });
        }),
      );
    }
  }

  // Filter out recipients that have been removed or have been updated.
  const filteredRecipients: RecipientDataWithClientId[] = existingRecipients.filter((recipient) => {
    const isRemoved = removedRecipients.find((removedRecipient) => removedRecipient.id === recipient.id);
    const isUpdated = persistedRecipients.find((persistedRecipient) => persistedRecipient.id === recipient.id);

    return !isRemoved && !isUpdated;
  });

  return {
    recipients: [...filteredRecipients, ...persistedRecipients].map((recipient) => ({
      ...recipient,
      documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
      templateId: null,
    })),
  };
};

/**
 * If you change this you MUST update the `hasRecipientBeenChanged` function.
 */
type RecipientData = {
  id?: number | null;
  clientId?: string | null;
  email: string;
  name: string;
  role: RecipientRole;
  signingOrder?: number | null;
  accessAuth?: TRecipientAccessAuthTypes[];
  actionAuth?: TRecipientActionAuthTypes[];
};

type RecipientDataWithClientId = Recipient & {
  clientId?: string | null;
};

const hasRecipientBeenChanged = (recipient: Recipient, newRecipientData: RecipientData) => {
  const authOptions = ZRecipientAuthOptionsSchema.parse(recipient.authOptions);

  const newRecipientAccessAuth = newRecipientData.accessAuth || [];
  const newRecipientActionAuth = newRecipientData.actionAuth || [];

  return (
    recipient.email !== newRecipientData.email ||
    recipient.name !== newRecipientData.name ||
    recipient.role !== newRecipientData.role ||
    // Null and undefined both mean "no order": the request schema cannot
    // carry null, so a persisted null arrives as undefined
    (recipient.signingOrder ?? null) !== (newRecipientData.signingOrder ?? null) ||
    !isDeepEqual(authOptions.accessAuth, newRecipientAccessAuth) ||
    !isDeepEqual(authOptions.actionAuth, newRecipientActionAuth)
  );
};
