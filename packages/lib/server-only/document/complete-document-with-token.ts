import { DEFAULT_DOCUMENT_DATE_FORMAT } from '@documenso/lib/constants/date-formats';
import { DEFAULT_DOCUMENT_TIME_ZONE } from '@documenso/lib/constants/time-zones';
import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import { DOCUMENT_AUDIT_LOG_TYPE, RECIPIENT_DIFF_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { RequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { fieldsContainUnsignedRequiredVisibleField, getHiddenFieldIds } from '@documenso/lib/utils/field-conditions';
import { prisma } from '@documenso/prisma';
import {
  DocumentSigningOrder,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SendStatus,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import type { TRecipientAccessAuth } from '../../types/document-auth';
import { DocumentAuth } from '../../types/document-auth';
import { isTspEnvelope } from '../../types/signature-level';
import type { TInPersonHostMarker } from '../../types/solidten-audit-logs';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapSecondaryIdToDocumentId, unsafeBuildEnvelopeIdQuery } from '../../utils/envelope';
import { getRecipientsInActiveSigningStep, isRecipientTurnBySigningOrder } from '../../utils/recipient-groups';
import { assertRecipientNotExpired, isRecipientBefore } from '../../utils/recipients';
import {
  assertEnvelopeOpenForRecipientAction,
  lockPendingEnvelope,
  RECIPIENT_ALREADY_ACTED_MESSAGE,
} from '../envelope/envelope-transition-lock';
import { assertRecipientFieldsCompleteUnderLock } from '../field/lock-field-write';
import { deleteStoredFieldFiles, type StoredFieldFile } from '../field-file/remove-field-files-in-transaction';
import { applyFieldLogic } from '../field-logic/apply-field-logic';
import { getIsRecipientsTurnToSign } from '../recipient/get-is-recipient-turn';
import { lockNextRecipientForDictation } from '../recipient-reassign/lock-dictated-next-signer';
import {
  applyRecipientHandoverInTransaction,
  assertDictatedNextSignerEmailAvailable,
  buildRecipientHandoverData,
} from '../recipient-reassign/recipient-handover';
import { assertSenderNotDisabled } from '../user/assert-user-not-disabled';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import { assertCompletionActorIsRecipient } from './assert-completion-actor';
import { isRecipientAuthorized } from './is-recipient-authorized';

export type CompleteDocumentWithTokenOptions = {
  token: string;
  id: EnvelopeIdOptions;
  userId?: number;
  accessAuthOptions?: TRecipientAccessAuth;
  requestMetadata?: RequestMetadata;
  nextSigner?: {
    email: string;
    name: string;
  };
  /**
   * Override the recipient information. This will only work if the recipient
   * does not have a name or email set.
   */
  recipientOverride?: {
    email?: string;
    name?: string;
  };
  /** Solid Ten Sign: the staff user who hosted this signer in person. */
  inPersonHost?: TInPersonHostMarker | null;
};

export const completeDocumentWithToken = async ({
  token,
  id,
  userId,
  accessAuthOptions,
  requestMetadata,
  nextSigner: dictatedNextSigner,
  recipientOverride,
  inPersonHost,
}: CompleteDocumentWithTokenOptions) => {
  const envelope = await prisma.envelope.findFirst({
    where: {
      ...unsafeBuildEnvelopeIdQuery(id, EnvelopeType.DOCUMENT),
      recipients: {
        some: {
          token,
        },
      },
    },
    include: {
      documentMeta: true,
      recipients: {
        where: {
          token,
        },
      },
    },
  });

  // The most common cause is a stale signing page: the document was deleted,
  // or the recipient was removed, after the link was opened. Surface a
  // NOT_FOUND instead of leaking a Prisma P2025 as a 500.
  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found for the provided signing token',
      statusCode: 404,
    });
  }

  await assertSenderNotDisabled({ userId: envelope.userId });

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  if (envelope.recipients.length === 0) {
    throw plainRefusal(
      AppErrorCode.NOT_FOUND,
      'This signing link is not valid.',
      { envelopeId: envelope.id },
      { statusCode: 404 },
    );
  }

  const [recipient] = envelope.recipients;

  // A retried or duplicate completion request for an already signed
  // recipient throws a code the router resolves idempotently. This must be
  // checked before the envelope status guard since the envelope may have
  // been completed and sealed by the recipient's original request.
  if (recipient.signingStatus === SigningStatus.SIGNED) {
    throw plainRefusal(
      AppErrorCode.RECIPIENT_ALREADY_SIGNED,
      'You have already signed this document.',
      { recipientId: recipient.id },
      { statusCode: 400 },
    );
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    const envelopeStatusErrorCode: Record<DocumentStatus, AppErrorCode> = {
      [DocumentStatus.DRAFT]: AppErrorCode.ENVELOPE_DRAFT,
      [DocumentStatus.COMPLETED]: AppErrorCode.ENVELOPE_COMPLETED,
      [DocumentStatus.REJECTED]: AppErrorCode.ENVELOPE_REJECTED,
      [DocumentStatus.CANCELLED]: AppErrorCode.ENVELOPE_CANCELLED,
      // Unreachable: guarded by the status check above.
      [DocumentStatus.PENDING]: AppErrorCode.INVALID_REQUEST,
    };

    throw plainRefusal(
      envelopeStatusErrorCode[envelope.status],
      'This document can no longer be signed.',
      { envelopeId: envelope.id, status: envelope.status },
      { statusCode: 400 },
    );
  }

  assertRecipientNotExpired(recipient);

  // Solid Ten: refuse a dictated email another recipient already has, before anything is written.
  if (dictatedNextSigner && envelope.documentMeta?.allowDictateNextSigner) {
    await assertDictatedNextSignerEmailAvailable({
      envelopeId: envelope.id,
      currentRecipientId: recipient.id,
      newEmail: dictatedNextSigner.email,
    });
  }

  if (recipient.signingStatus === SigningStatus.REJECTED) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      // Solid Ten Sign (SEC3-L1): the same wording as the decision inside the lock.
      message: RECIPIENT_ALREADY_ACTED_MESSAGE,
      userMessage: RECIPIENT_ALREADY_ACTED_MESSAGE,
      statusCode: 400,
    });
  }

  if (envelope.documentMeta?.signingOrder === DocumentSigningOrder.SEQUENTIAL) {
    const isRecipientsTurn = await getIsRecipientsTurnToSign({
      token: recipient.token,
    });

    if (!isRecipientsTurn) {
      throw plainRefusal(
        AppErrorCode.RECIPIENT_OUT_OF_TURN,
        'It is not your turn to sign yet. You get an email when it is.',
        { recipientId: recipient.id },
        { statusCode: 400 },
      );
    }
  }

  // Solid Ten Sign (AUD-C11): with action auth, another signed-in account cannot complete.
  await assertCompletionActorIsRecipient({ documentAuth: envelope.authOptions, recipient, userId });

  // Check ACCESS AUTH 2FA validation during document completion
  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  if (derivedRecipientAccessAuth.includes(DocumentAuth.TWO_FACTOR_AUTH)) {
    if (!accessAuthOptions) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Access authentication required',
      });
    }

    if (!recipient.email.trim()) {
      throw plainRefusal(
        AppErrorCode.INVALID_REQUEST,
        'An email address is needed to finish, because this document asks the signer to confirm who they are.',
        { recipientId: recipient.id },
      );
    }

    const isValid = await isRecipientAuthorized({
      type: 'ACCESS_2FA',
      documentAuthOptions: envelope.authOptions,
      recipient: recipient,
      userId, // Can be undefined for non-account recipients
      authOptions: accessAuthOptions,
      requestMetadata,
    });

    if (!isValid) {
      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED,
          envelopeId: envelope.id,
          data: {
            recipientId: recipient.id,
            recipientName: recipient.name,
            recipientEmail: recipient.email,
          },
        }),
      });

      throw new AppError(AppErrorCode.TWO_FACTOR_AUTH_FAILED, {
        message: 'Invalid 2FA authentication',
      });
    }

    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED,
        envelopeId: envelope.id,
        data: {
          recipientId: recipient.id,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
        },
      }),
    });
  }

  let fields = await prisma.field.findMany({
    where: {
      envelopeId: envelope.id,
      recipientId: recipient.id,
    },
  });

  const hiddenFieldIds = getHiddenFieldIds(fields);

  // This should be scoped to the current recipient.
  const uninsertedDateFields = fields.filter(
    (field) => field.type === FieldType.DATE && !field.inserted && !hiddenFieldIds.has(field.id),
  );

  let recipientName = recipient.name;
  let recipientEmail = recipient.email;

  // Only trim the name if it's been derived.
  if (!recipientName) {
    recipientName = (
      recipientOverride?.name ||
      fields.find((field) => field.type === FieldType.NAME)?.customText ||
      ''
    ).trim();
  }

  // Only trim the email if it's been derived.
  if (!recipient.email) {
    recipientEmail = (
      recipientOverride?.email ||
      fields.find((field) => field.type === FieldType.EMAIL)?.customText ||
      ''
    )
      .trim()
      .toLowerCase();
  }

  if (!recipientEmail) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Recipient email is required',
    });
  }

  // Auto-insert all un-inserted date fields for V2 envelopes at completion time.
  if (envelope.internalVersion === 2 && uninsertedDateFields.length > 0) {
    const formattedDate = DateTime.now()
      .setZone(envelope.documentMeta?.timezone ?? DEFAULT_DOCUMENT_TIME_ZONE)
      .toFormat(envelope.documentMeta?.dateFormat ?? DEFAULT_DOCUMENT_DATE_FORMAT);

    const newDateFieldValues = {
      customText: formattedDate,
      inserted: true,
    };

    await prisma.field.updateMany({
      where: {
        id: {
          in: uninsertedDateFields.map((field) => field.id),
        },
      },
      data: {
        ...newDateFieldValues,
      },
    });

    // Create audit log entries for each auto-inserted date field.
    await prisma.documentAuditLog.createMany({
      data: uninsertedDateFields.map((field) =>
        createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
          envelopeId: envelope.id,
          user: {
            email: recipientEmail,
            name: recipientName,
          },
          requestMetadata,
          data: {
            recipientEmail: recipientEmail,
            recipientId: recipient.id,
            recipientName: recipientName,
            recipientRole: recipient.role,
            fieldId: field.secondaryId,
            field: {
              type: FieldType.DATE,
              data: formattedDate,
            },
          },
        }),
      ),
    });

    // Update the local fields array so the subsequent validation check passes.
    fields = fields.map((field) => {
      if (field.type === FieldType.DATE && !field.inserted) {
        return {
          ...field,
          ...newDateFieldValues,
        };
      }

      return field;
    });
  }

  const { changedFields } = await prisma.$transaction(async (tx) =>
    applyFieldLogic({
      tx,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      user: { name: recipientName, email: recipientEmail },
      requestMetadata,
    }),
  );

  fields = fields.map((field) => changedFields.find((changedField) => changedField.id === field.id) ?? field);

  if (fieldsContainUnsignedRequiredVisibleField(fields)) {
    throw plainRefusal(
      AppErrorCode.RECIPIENT_HAS_UNSIGNED_FIELDS,
      'Fill in every required field before you finish.',
      { recipientId: recipient.id },
      { statusCode: 400 },
    );
  }

  await prisma.$transaction(async (tx) => {
    // Solid Ten: hold the envelope lock so a cancel, reject or delete cannot interleave.
    await lockPendingEnvelope(tx, envelope.id);

    // Solid Ten Sign (FS2-C1): another recipient's decline already ends the document.
    await assertEnvelopeOpenForRecipientAction(tx, envelope.id, recipient.id);

    // Solid Ten Sign (AUD-C2): field rules and the required-field check again, under the lock.
    await assertRecipientFieldsCompleteUnderLock(tx, {
      envelopeId: envelope.id,
      recipientId: recipient.id,
      user: { name: recipientName, email: recipientEmail },
      requestMetadata,
    });

    // Conditional update so two concurrent completion requests can't both
    // proceed: only the request that transitions the recipient to SIGNED
    // continues, the loser sees a count of 0 and aborts.
    const { count: updatedRecipientCount } = await tx.recipient.updateMany({
      // Solid Ten Sign (FS2-C1): only from NOT_SIGNED. "Not SIGNED" also matched a recipient
      // who had just declined, so a decline and a completion could both win.
      where: {
        id: recipient.id,
        // The link the signer used: a handover in the meantime gives a new token.
        token: recipient.token,
        signingStatus: SigningStatus.NOT_SIGNED,
        // Still inside the signing window at the moment of the write (the expiry sweep may
        // have run since the first check).
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: {
        signingStatus: SigningStatus.SIGNED,
        signedAt: new Date(),
        name: recipientName,
        email: recipientEmail,
      },
    });

    // A concurrent request completed the recipient between our initial read
    // and this transaction. Abort so the winning request handles all side
    // effects, the router resolves this code idempotently.
    if (updatedRecipientCount === 0) {
      const current = await tx.recipient.findUnique({
        where: { id: recipient.id },
        select: { signingStatus: true, expiresAt: true },
      });

      if (current?.signingStatus === SigningStatus.NOT_SIGNED) {
        assertRecipientNotExpired(current);

        // Not signed, not expired: the request was handed to someone else and this link died.
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'This signing request was passed to someone else. This link no longer works.',
          userMessage: 'This signing request was passed to someone else. This link no longer works.',
          statusCode: 400,
        });
      }

      if (!current) {
        throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Recipient not found', statusCode: 404 });
      }

      // A decline won the race: refuse cleanly, nothing is written.
      if (current?.signingStatus === SigningStatus.REJECTED) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: RECIPIENT_ALREADY_ACTED_MESSAGE,
          userMessage: RECIPIENT_ALREADY_ACTED_MESSAGE,
          statusCode: 400,
        });
      }

      throw plainRefusal(
        AppErrorCode.RECIPIENT_ALREADY_SIGNED,
        'You have already signed this document.',
        { recipientId: recipient.id },
        { statusCode: 400 },
      );
    }

    if (recipientEmail !== recipient.email || recipientName !== recipient.name) {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
          envelopeId: envelope.id,
          user: {
            name: recipientName,
            email: recipientEmail,
          },
          requestMetadata,
          data: {
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            recipientId: recipient.id,
            recipientRole: recipient.role,
            changes: [
              {
                type: RECIPIENT_DIFF_TYPE.NAME,
                from: recipient.name,
                to: recipientName,
              },
              {
                type: RECIPIENT_DIFF_TYPE.EMAIL,
                from: recipient.email,
                to: recipientEmail,
              },
            ],
          },
        }),
      });
    }

    const authOptions = extractDocumentAuthMethods({
      documentAuth: envelope.authOptions,
      recipientAuth: recipient.authOptions,
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED,
        envelopeId: envelope.id,
        user: {
          name: recipientName,
          email: recipientEmail,
        },
        requestMetadata,
        data: {
          recipientEmail: recipientEmail,
          recipientName: recipientName,
          recipientId: recipient.id,
          recipientRole: recipient.role,
          actionAuth: authOptions.derivedRecipientActionAuth,
          // Solid Ten (AUD-8): what this recipient passed to open the document.
          accessAuth: authOptions.derivedRecipientAccessAuth,
          ...(inPersonHost ? { inPersonHost } : {}),
        },
      }),
    });
  });

  const envelopeWithRelations = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelope.id },
    include: { documentMeta: true, recipients: true },
  });

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_RECIPIENT_COMPLETED,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelopeWithRelations)),
    userId: envelope.userId,
    teamId: envelope.teamId,
  });

  await jobs.triggerJob({
    name: 'send.recipient.signed.email',
    payload: {
      documentId: legacyDocumentId,
      recipientId: recipient.id,
    },
  });

  const pendingRecipients = await prisma.recipient.findMany({
    select: {
      id: true,
      signingOrder: true,
      signingStatus: true,
      name: true,
      email: true,
      role: true,
      expiresAt: true,
      token: true,
    },
    where: {
      envelopeId: envelope.id,
      signingStatus: {
        not: SigningStatus.SIGNED,
      },
      role: {
        not: RecipientRole.CC,
      },
    },
    // Composite sort so our next recipient is always the one with the lowest signing order or id
    // if there is a tie.
    orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  });

  if (pendingRecipients.length > 0) {
    await jobs.triggerJob({
      name: 'send.document.pending.email',
      payload: {
        envelopeId: envelope.id,
        recipientId: recipient.id,
      },
    });

    if (envelope.documentMeta?.signingOrder === DocumentSigningOrder.SEQUENTIAL) {
      const sequencing = { strictlySequential: isTspEnvelope(envelope) };

      const nextRecipients = getRecipientsInActiveSigningStep(pendingRecipients, sequencing);

      // Peers still pending in the current step are not the "next" step:
      // nobody advances until the whole group has completed.
      const hasCompletedCurrentStep = nextRecipients.every((pendingRecipient) =>
        isRecipientBefore(recipient, pendingRecipient, sequencing),
      );

      if (
        nextRecipients.length > 0 &&
        hasCompletedCurrentStep &&
        // Ensure that the next recipient can actually act on the document.
        isRecipientTurnBySigningOrder(pendingRecipients, nextRecipients[0], sequencing)
      ) {
        // Dictation is only allowed when advancing to a single-recipient step.
        const canDictateNextSigner =
          Boolean(dictatedNextSigner) &&
          Boolean(envelope.documentMeta?.allowDictateNextSigner) &&
          nextRecipients.length === 1;

        // Solid Ten Sign (AUD-C1): set when the dictation found the next recipient changed.
        let isDictationSkipped = false;

        if (canDictateNextSigner && dictatedNextSigner) {
          const removedFiles: StoredFieldFile[] = [];

          isDictationSkipped = !(await prisma.$transaction(async (tx) => {
            const [nextRecipient] = nextRecipients;

            // Solid Ten Sign (AUD-C1): envelope lock, then the next recipient must be unchanged.
            if (!(await lockNextRecipientForDictation(tx, envelope.id, nextRecipient))) {
              return false;
            }

            // Solid Ten: a different person means a new link. The sender may already have
            // copied the old one (manual link sharing), and it must not sign as the new person.
            const isHandover = nextRecipient.email.toLowerCase() !== dictatedNextSigner.email.toLowerCase();

            await tx.recipient.update({
              where: { id: nextRecipient.id },
              data: {
                sendStatus: SendStatus.SENT,
                sentAt: new Date(),
                name: dictatedNextSigner.name,
                email: dictatedNextSigner.email.toLowerCase(),
                ...(isHandover
                  ? buildRecipientHandoverData({
                      previousExpiresAt: nextRecipient.expiresAt,
                      envelopeExpirationPeriod: envelope.documentMeta?.envelopeExpirationPeriod,
                    })
                  : {}),
              },
            });

            if (isHandover) {
              await applyRecipientHandoverInTransaction(tx, {
                envelopeId: envelope.id,
                internalVersion: envelope.internalVersion,
                recipient: nextRecipient,
                toName: dictatedNextSigner.name,
                toEmail: dictatedNextSigner.email.toLowerCase(),
                newPhone: null,
                reassignedBy: 'SIGNER',
                trigger: 'DICTATED_NEXT_SIGNER',
                auditUser: { name: recipientName, email: recipientEmail },
                requestMetadata,
                removedFiles,
              });
            }

            await tx.documentAuditLog.create({
              data: createDocumentAuditLogData({
                type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
                envelopeId: envelope.id,
                user: {
                  name: recipientName,
                  email: recipientEmail,
                },
                requestMetadata,
                data: {
                  recipientEmail: nextRecipient.email,
                  recipientName: nextRecipient.name,
                  recipientId: nextRecipient.id,
                  recipientRole: nextRecipient.role,
                  changes: [
                    {
                      type: RECIPIENT_DIFF_TYPE.NAME,
                      from: nextRecipient.name,
                      to: dictatedNextSigner.name,
                    },
                    {
                      type: RECIPIENT_DIFF_TYPE.EMAIL,
                      from: nextRecipient.email,
                      to: dictatedNextSigner.email.toLowerCase(),
                    },
                  ],
                },
              }),
            });

            return true;
          }));

          await deleteStoredFieldFiles(removedFiles);
        } else {
          await prisma.recipient.updateMany({
            where: {
              id: {
                in: nextRecipients.map((nextRecipient) => nextRecipient.id),
              },
            },
            data: {
              sendStatus: SendStatus.SENT,
              sentAt: new Date(),
            },
          });
        }

        await Promise.allSettled(
          (isDictationSkipped ? [] : nextRecipients).map((nextRecipient) =>
            jobs.triggerJob({
              name: 'send.signing.requested.email',
              payload: {
                userId: envelope.userId,
                documentId: legacyDocumentId,
                recipientId: nextRecipient.id,
                requestMetadata,
              },
            }),
          ),
        );
      }
    }
  }

  const haveAllRecipientsSigned = await prisma.envelope.findFirst({
    where: {
      id: envelope.id,
      recipients: {
        every: {
          OR: [{ signingStatus: SigningStatus.SIGNED }, { role: RecipientRole.CC }],
        },
      },
    },
  });

  if (haveAllRecipientsSigned) {
    await jobs.triggerJob({
      name: 'internal.seal-document',
      payload: {
        documentId: legacyDocumentId,
        requestMetadata,
      },
    });
  }

  const updatedDocument = await prisma.envelope.findFirstOrThrow({
    where: {
      id: envelope.id,
      type: EnvelopeType.DOCUMENT,
    },
    include: {
      documentMeta: true,
      recipients: true,
    },
  });

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_SIGNED,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(updatedDocument)),
    userId: updatedDocument.userId,
    teamId: updatedDocument.teamId ?? undefined,
  });
};
