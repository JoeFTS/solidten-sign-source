// This is closely related to `reject-document-on-behalf-of.ts` but is intentionally
// kept as a separate method rather than merged into one. This file focuses on
// rejection from a recipient perspective (the recipient rejecting via their token),
// whereas `reject-document-on-behalf-of.ts` focuses on it from an API/programmatic
// perspective (an authenticated API user acting on behalf of a recipient).
//
// Code changes in one should probably be mirrored to the other, particularly in
// relation to the jobs triggered after a rejection.

import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import { jobs } from '@documenso/lib/jobs/client';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, SigningStatus } from '@prisma/client';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { TRecipientAccessAuth } from '../../types/document-auth';
import type { TInPersonHostMarker } from '../../types/solidten-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapSecondaryIdToDocumentId, unsafeBuildEnvelopeIdQuery } from '../../utils/envelope';
import { assertRecipientNotExpired } from '../../utils/recipients';
import {
  assertEnvelopeOpenForRecipientAction,
  RECIPIENT_ALREADY_ACTED_MESSAGE,
  rejectRecipientUnderLock,
  withLockedPendingEnvelope,
} from '../envelope/envelope-transition-lock';
import { assertSenderNotDisabled } from '../user/assert-user-not-disabled';
import { assertAccess2FAForTokenAction } from './assert-access-2fa-for-token-action';
import { assertActionAuthActorIsRecipient } from './assert-completion-actor';

export type RejectDocumentWithTokenOptions = {
  token: string;
  id: EnvelopeIdOptions;
  reason: string;
  requestMetadata?: RequestMetadata;
  /** Solid Ten Sign: the staff user who hosted this signer in person. */
  inPersonHost?: TInPersonHostMarker | null;
  /** Solid Ten Sign (AUD-14): the emailed access code, when the recipient's access needs one. */
  accessAuthOptions?: TRecipientAccessAuth;
  /** The signed-in recipient, if any (never the host on an in-person device). */
  userId?: number;
};

export async function rejectDocumentWithToken({
  token,
  id,
  reason,
  requestMetadata,
  inPersonHost,
  accessAuthOptions,
  userId,
}: RejectDocumentWithTokenOptions) {
  // Find the recipient and document in a single query
  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
      envelope: unsafeBuildEnvelopeIdQuery(id, EnvelopeType.DOCUMENT),
    },
    include: {
      envelope: true,
    },
  });

  const envelope = recipient?.envelope;

  if (!recipient || !envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document or recipient not found',
    });
  }

  await assertSenderNotDisabled({ userId: envelope.userId });

  if (envelope.status !== DocumentStatus.PENDING) {
    throw plainRefusal(AppErrorCode.INVALID_REQUEST, 'This document can no longer be declined.', {
      envelopeId: envelope.id,
      status: envelope.status,
    });
  }

  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      // Solid Ten Sign (SEC3-L1): plain wording, the same as the decline inside the lock.
      message: RECIPIENT_ALREADY_ACTED_MESSAGE,
      userMessage: RECIPIENT_ALREADY_ACTED_MESSAGE,
    });
  }

  assertRecipientNotExpired(recipient);

  // Solid Ten Sign (AUD-14): a decline needs the emailed access code, as completion does.
  await assertAccess2FAForTokenAction({ envelope, recipient, userId, accessAuthOptions, requestMetadata });

  // Solid Ten Sign (AUD-C11 follow-up): with action auth, only the recipient's own session declines.
  await assertActionAuthActorIsRecipient({ documentAuth: envelope.authOptions, recipient, userId });

  // Update the recipient status to rejected
  const updatedRecipient = await withLockedPendingEnvelope(envelope.id, async (tx) => {
    // Solid Ten: under the envelope lock, and only while the recipient has not acted.
    // Solid Ten Sign (FS2-C1): one winner against a racing completion or decline; the
    // loser gets a clean 400 and writes nothing (no audit entry, no jobs).
    await assertEnvelopeOpenForRecipientAction(tx, envelope.id, recipient.id);

    const rejected = await rejectRecipientUnderLock(tx, { recipientId: recipient.id, token: recipient.token, reason });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED,
        user: {
          name: recipient.name,
          email: recipient.email,
        },
        data: {
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          recipientId: recipient.id,
          recipientRole: recipient.role,
          reason,
          // Solid Ten (AUD-8): what this recipient passed to open the document.
          accessAuth: extractDocumentAuthMethods({
            documentAuth: envelope.authOptions,
            recipientAuth: recipient.authOptions,
          }).derivedRecipientAccessAuth,
          ...(inPersonHost ? { inPersonHost } : {}),
        },
        requestMetadata,
      }),
    });

    return rejected;
  });

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  // Trigger the seal document job to process the document asynchronously
  await jobs.triggerJob({
    name: 'internal.seal-document',
    payload: {
      documentId: legacyDocumentId,
      requestMetadata,
    },
  });

  // Send email notifications to the rejecting recipient
  await jobs.triggerJob({
    name: 'send.signing.rejected.emails',
    payload: {
      recipientId: recipient.id,
      documentId: legacyDocumentId,
    },
  });

  // Send cancellation emails to other recipients
  await jobs.triggerJob({
    name: 'send.document.cancelled.emails',
    payload: {
      documentId: legacyDocumentId,
      cancellationReason: reason,
      requestMetadata,
    },
  });

  return updatedRecipient;
}
