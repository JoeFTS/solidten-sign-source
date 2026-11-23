import { prisma } from '@documenso/prisma';
import { DocumentStatus, SigningStatus } from '@prisma/client';
import { z } from 'zod';

import { lockEnvelopeRow } from '../../../server-only/envelope/envelope-transition-lock';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { mapDocumentIdToSecondaryId } from '../../../utils/envelope';
import { jobs } from '../../client';

const ZSealPayloadSchema = z.object({ documentId: z.number() });

/** The notice is sent once per envelope, also when the seal sweep's reseals fail again. */
export const sealFailedNoticeJobId = (envelopeId: string) => `seal-failed:${envelopeId}`;

/**
 * Solid Ten Sign (S-2): a seal (the final PDF) failed on every attempt.
 *
 * Before, nobody was told: the signers saw "Document Signed", the envelope stayed PENDING, and
 * after the seal sweep's 6-hour window nothing tried again. Now, once per envelope: one
 * DOCUMENT_SEAL_FAILED audit entry, and one notice to the document owner and the server
 * operators (send.solidten.notice.email, id seal-failed:<envelopeId>). Never to signers.
 *
 * Only for a PENDING envelope (a failed admin reseal of a finished document is not this case).
 * A later reseal that works needs nothing more: no second notice.
 */
export const markSealFailed = async ({ payload, attempts }: { payload: unknown; attempts: number }) => {
  const parsed = ZSealPayloadSchema.safeParse(payload);

  if (!parsed.success) {
    return;
  }

  const secondaryId = mapDocumentIdToSecondaryId(parsed.data.documentId);

  const marked = await prisma.$transaction(async (tx) => {
    const envelope = await tx.envelope.findFirst({
      where: { secondaryId },
      select: { id: true },
    });

    if (!envelope) {
      return null;
    }

    // One at a time per envelope, so two final failures write one entry.
    const status = await lockEnvelopeRow(tx, envelope.id);

    if (status !== DocumentStatus.PENDING) {
      return null;
    }

    const isRejected =
      (await tx.recipient.count({
        where: { envelopeId: envelope.id, signingStatus: SigningStatus.REJECTED },
      })) > 0;

    const existing = await tx.documentAuditLog.findFirst({
      where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SEAL_FAILED },
      select: { id: true },
    });

    // Already recorded: the notice below is queued again only if it never was (its id is fixed).
    if (existing) {
      return { envelopeId: envelope.id, isRejected };
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SEAL_FAILED,
        envelopeId: envelope.id,
        data: { attempts, isRejected },
      }),
    });

    return { envelopeId: envelope.id, isRejected };
  });

  if (!marked) {
    return;
  }

  await jobs.triggerJob({
    id: sealFailedNoticeJobId(marked.envelopeId),
    name: 'send.solidten.notice.email',
    payload: { kind: 'SEAL_FAILED', envelopeId: marked.envelopeId, isRejected: marked.isRejected },
  });
};
