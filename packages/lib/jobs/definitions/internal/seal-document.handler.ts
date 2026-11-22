import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { finalizeTspEnvelopeCompletion } from '@documenso/ee/server-only/signing/csc/finalize-tsp-completion';
import { generateAuditLogPdf } from '@documenso/lib/server-only/pdf/generate-audit-log-pdf';
import { generateCertificatePdf } from '@documenso/lib/server-only/pdf/generate-certificate-pdf';
import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import type { DocumentData, Envelope, EnvelopeContent, EnvelopeItem, Field } from '@prisma/client';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus, WebhookTriggerEvents } from '@prisma/client';
import { nanoid } from 'nanoid';

import { NEXT_PRIVATE_USE_PLAYWRIGHT_PDF } from '../../../constants/app';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import { loadContentImageBytes } from '../../../server-only/data-content/load-content-images';
import { getAuditLogsPdf } from '../../../server-only/htmltopdf/get-audit-logs-pdf';
import { getCertificatePdf } from '../../../server-only/htmltopdf/get-certificate-pdf';
import { getLastPageSizeIsolated, sealPdfIsolated } from '../../../server-only/pdf-child/isolated-pdf';
import { getTeamSettings } from '../../../server-only/team/get-team-settings';
import { triggerWebhook } from '../../../server-only/webhooks/trigger/trigger-webhook';
import { DOCUMENT_AUDIT_LOG_TYPE, type TDocumentAuditLog } from '../../../types/document-audit-logs';
import { isTspEnvelope } from '../../../types/signature-level';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../../types/webhook-payload';
import { prefixedId } from '../../../universal/id';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { putPdfFileServerSide } from '../../../universal/upload/put-file.server';
import { isDocumentCompleted } from '../../../utils/document';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { mapDocumentIdToSecondaryId } from '../../../utils/envelope';
import { fieldsContainUnsignedRequiredVisibleField } from '../../../utils/field-conditions';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSealDocumentJobDefinition } from './seal-document';

export const run = async ({ payload, io }: { payload: TSealDocumentJobDefinition; io: JobRunIO }) => {
  const { documentId, sendEmail = true, isResealing = false, requestMetadata } = payload;

  const { envelopeId, envelopeStatus, isRejected, isSuperseded } = await io.runTask('seal-document', async () => {
    const envelope = await prisma.envelope.findFirst({
      where: {
        type: EnvelopeType.DOCUMENT,
        secondaryId: mapDocumentIdToSecondaryId(documentId),
      },
      include: {
        user: {
          select: {
            name: true,
            email: true,
          },
        },
        documentMeta: true,
        recipients: true,
        fields: {
          include: {
            signature: true,
          },
        },
        envelopeItems: {
          include: {
            documentData: true,
            field: {
              include: {
                signature: true,
              },
            },
            contents: true,
          },
        },
      },
    });

    // Solid Ten: the document is gone (the retention purge or a hard delete won the race). Nothing
    // to seal; failing would only retry until the budget is spent.
    if (!envelope) {
      io.logger.info(`Document ${documentId} no longer exists; nothing to seal`);

      return supersededSealResult('', DocumentStatus.PENDING);
    }

    if (envelope.envelopeItems.length === 0) {
      throw new Error('At least one envelope item required');
    }

    // Solid Ten: another writer (cancel, delete, an earlier seal) already moved the envelope.
    if (!getSealableStatuses(isResealing).includes(envelope.status)) {
      return supersededSealResult(envelope.id, envelope.status);
    }

    const settings = await getTeamSettings({
      userId: envelope.userId,
      teamId: envelope.teamId,
    });

    // Ensure all CC recipients are marked as signed
    await prisma.recipient.updateMany({
      where: {
        envelopeId: envelope.id,
        role: RecipientRole.CC,
      },
      data: {
        signingStatus: SigningStatus.SIGNED,
      },
    });

    const isComplete =
      envelope.recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED) ||
      envelope.recipients.every(
        (recipient) => recipient.signingStatus === SigningStatus.SIGNED || recipient.role === RecipientRole.CC,
      );

    if (!isComplete) {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'Document is not complete',
      });
    }

    let { envelopeItems } = envelope;

    const fields = envelope.fields;

    if (envelopeItems.length < 1) {
      throw new Error(`Document ${envelope.id} has no envelope items`);
    }

    const recipientsWithoutCCers = envelope.recipients.filter((recipient) => recipient.role !== RecipientRole.CC);

    // Determine if the document has been rejected by checking if any recipient has rejected it
    const rejectedRecipient = recipientsWithoutCCers.find(
      (recipient) => recipient.signingStatus === SigningStatus.REJECTED,
    );

    const isRejected = Boolean(rejectedRecipient);

    // Get the rejection reason from the rejected recipient
    const rejectionReason = rejectedRecipient?.rejectionReason ?? '';

    // Skip the field check if the document is rejected
    if (!isRejected && fieldsContainUnsignedRequiredVisibleField(fields)) {
      throw new Error(`Document ${envelope.id} has unsigned required fields`);
    }

    if (isResealing) {
      // If we're resealing we want to use the initial data for the document
      // so we aren't placing fields on top of eachother.
      envelopeItems = envelopeItems.map((envelopeItem) => ({
        ...envelopeItem,
        documentData: {
          ...envelopeItem.documentData,
          data: envelopeItem.documentData.initialData,
        },
      }));
    }

    if (!envelope.qrToken) {
      await prisma.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          qrToken: prefixedId('qr'),
        },
      });
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const envelopeCompletedAuditLog = createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_COMPLETED,
      envelopeId: envelope.id,
      requestMetadata,
      user: null,
      data: {
        transactionId: nanoid(),
        ...(isRejected ? { isRejected: true, rejectionReason: rejectionReason } : {}),
      },
    });

    const finalEnvelopeStatus = isRejected ? DocumentStatus.REJECTED : DocumentStatus.COMPLETED;

    if (isTspEnvelope(envelope)) {
      if (isResealing) {
        throw new AppError(AppErrorCode.NOT_SETUP, {
          message: 'Re-sealing TSP envelopes is not supported — recipient signatures cannot be regenerated externally.',
        });
      }

      if (isRejected) {
        throw new AppError(AppErrorCode.NOT_SETUP, {
          message:
            'TSP envelope rejection is not supported in V1 — rejection stamps would invalidate PAdES signatures.',
        });
      }

      await finalizeTspEnvelopeCompletion({
        envelope,
        envelopeCompletedAuditLog,
        requestMetadata,
      });

      return {
        envelopeId: envelope.id,
        envelopeStatus: envelope.status,
        isRejected,
        isSuperseded: false,
      };
    }

    // Pre-fetch all PDF data so we can read dimensions and pass it
    // to decorateAndSignPdf without fetching again.
    const prefetchedItems = await Promise.all(
      envelopeItems.map(async (envelopeItem) => {
        const pdfData = await getFileServerSide(envelopeItem.documentData);

        return { envelopeItem, pdfData };
      }),
    );

    const usePlaywrightPdf = NEXT_PRIVATE_USE_PLAYWRIGHT_PDF();

    const needsCertificate = settings.includeSigningCertificate;
    const needsAuditLog = settings.includeAuditLog;

    const newDocumentData: Array<{ oldDocumentDataId: string; newDocumentDataId: string }> = [];

    for (const { envelopeItem, pdfData } of prefetchedItems) {
      const originalEnvelopeItem = envelope.envelopeItems.find((item) => item.id === envelopeItem.id);

      if (!originalEnvelopeItem) {
        throw new Error(`Envelope item fields not found for envelope item ${envelopeItem.id}`);
      }

      const envelopeItemFields = originalEnvelopeItem.field;

      // Contents are inserted into the PDF when the envelope is sent, so the
      // current bytes already carry them and must not be drawn again. Only a
      // reseal starts over from the `initialData` and has to reinsert them.
      const envelopeItemContents = isResealing ? originalEnvelopeItem.contents : [];

      let certificateDoc: PDF | null = null;
      let auditLogDoc: PDF | null = null;

      if (needsCertificate || needsAuditLog) {
        // Solid Ten: read in a PDF child for a large document (SEC3-M1, LD3-H1).
        const { width: pageWidth, height: pageHeight } = await getLastPageSizeIsolated(pdfData);

        const additionalAuditLogs = [
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          {
            ...envelopeCompletedAuditLog,
            id: '',
            createdAt: new Date(),
          } as TDocumentAuditLog,
        ];

        const certificatePayload = {
          envelope: {
            ...envelope,
            status: finalEnvelopeStatus,
          },
          recipients: envelope.recipients,
          fields,
          language: envelope.documentMeta.language,
          envelopeOwner: {
            email: envelope.user.email,
            name: envelope.user.name || '',
          },
          envelopeItems: envelopeItems.map((item) => item.title),
          pageWidth,
          pageHeight,
          additionalAuditLogs,
        };

        const makeCertificatePdf = async () =>
          usePlaywrightPdf
            ? getCertificatePdf({
                documentId,
                language: envelope.documentMeta.language,
              }).then(async (buffer) => PDF.load(buffer))
            : generateCertificatePdf(certificatePayload);

        const makeAuditLogPdf = async () =>
          usePlaywrightPdf
            ? getAuditLogsPdf({
                documentId,
                language: envelope.documentMeta.language,
              }).then(async (buffer) => PDF.load(buffer))
            : generateAuditLogPdf(certificatePayload);

        [certificateDoc, auditLogDoc] = await Promise.all([
          needsCertificate ? makeCertificatePdf() : null,
          needsAuditLog ? makeAuditLogPdf() : null,
        ]);
      }

      const result = await decorateAndSignPdf({
        envelope,
        envelopeItem,
        envelopeItemFields,
        envelopeItemContents,
        isRejected,
        rejectionReason,
        pdfData,
        certificateDoc,
        auditLogDoc,
      });

      newDocumentData.push(result);
    }

    const hasMovedEnvelope = await prisma.$transaction(async (tx) => {
      // Solid Ten: move the envelope only from a status the seal may finish. A cancel that won the
      // race leaves 0 rows here; the transaction rolls back and the seal stops without side effects.
      const { count } = await tx.envelope.updateMany({
        where: {
          id: envelope.id,
          status: { in: getSealableStatuses(isResealing) },
        },
        data: {
          status: finalEnvelopeStatus,
          completedAt: new Date(),
        },
      });

      if (count === 0) {
        return false;
      }

      for (const { oldDocumentDataId, newDocumentDataId } of newDocumentData) {
        await tx.envelopeItem.update({
          where: {
            envelopeId: envelope.id,
            documentDataId: oldDocumentDataId,
          },
          data: {
            documentDataId: newDocumentDataId,
          },
        });
      }

      await tx.documentAuditLog.create({
        data: envelopeCompletedAuditLog,
      });

      return true;
    });

    if (!hasMovedEnvelope) {
      // Solid Ten: the signed copies written above are referenced by nothing.
      await prisma.documentData
        .deleteMany({ where: { id: { in: newDocumentData.map(({ newDocumentDataId }) => newDocumentDataId) } } })
        .catch((error: unknown) => io.logger.warn('Could not remove the unused signed copies', error));

      return supersededSealResult(envelope.id, envelope.status);
    }

    return {
      envelopeId: envelope.id,
      envelopeStatus: envelope.status,
      isRejected,
      isSuperseded: false,
    };
  });

  if (isSuperseded) {
    io.logger.info(`Envelope ${envelopeId} left the sealable state before the seal finished; nothing sent`);

    return;
  }

  // Solid Ten: a re-run of this job (a crash after the follow-ups below were queued) must not
  // queue them again (FS2-L1). The id is cached per job, so a re-run reuses it; a new seal job
  // (an admin reseal) gets a new one and notifies webhooks again, as before.
  const { sealRunId } = await io.runTask('seal-run-id', async () => ({ sealRunId: randomUUID() }));

  const updatedEnvelope = await prisma.envelope.findFirst({
    where: {
      id: envelopeId,
    },
    include: {
      documentMeta: true,
      recipients: true,
    },
  });

  // Solid Ten: purged right after it was sealed: nobody is left to tell.
  if (!updatedEnvelope) {
    io.logger.info(`Envelope ${envelopeId} no longer exists; no follow-ups sent`);

    return;
  }

  await triggerWebhook({
    event: isRejected ? WebhookTriggerEvents.DOCUMENT_REJECTED : WebhookTriggerEvents.DOCUMENT_COMPLETED,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(updatedEnvelope)),
    userId: updatedEnvelope.userId,
    teamId: updatedEnvelope.teamId ?? undefined,
    idempotencyKey: `seal:${sealRunId}`,
  });

  let shouldSendCompletedEmail = sendEmail && !isResealing && !isRejected;

  if (isResealing && !isDocumentCompleted(envelopeStatus)) {
    shouldSendCompletedEmail = sendEmail;
  }

  if (shouldSendCompletedEmail) {
    await jobs.triggerJob({
      // Solid Ten: once per envelope (FS2-L1). Resending a completed document has its own action.
      id: `completed-emails:${envelopeId}`,
      name: 'send.document.completed.emails',
      payload: {
        envelopeId,
        requestMetadata,
      },
    });
  }
};

/**
 * Solid Ten: the statuses a seal may move the envelope from. A first seal only finishes a
 * PENDING envelope; a reseal (admin action or the seal sweep) may also redo a finished one.
 */
const getSealableStatuses = (isResealing: boolean): DocumentStatus[] =>
  isResealing ? [DocumentStatus.PENDING, DocumentStatus.COMPLETED, DocumentStatus.REJECTED] : [DocumentStatus.PENDING];

const supersededSealResult = (envelopeId: string, envelopeStatus: DocumentStatus) => ({
  envelopeId,
  envelopeStatus,
  isRejected: false,
  isSuperseded: true,
});

type DecorateAndSignPdfOptions = {
  envelope: Pick<Envelope, 'id' | 'title' | 'useLegacyFieldInsertion' | 'internalVersion'>;
  envelopeItem: EnvelopeItem & { documentData: DocumentData };
  envelopeItemFields: Field[];
  envelopeItemContents: EnvelopeContent[];
  isRejected: boolean;
  rejectionReason: string;
  pdfData: Uint8Array;
  certificateDoc: PDF | null;
  auditLogDoc: PDF | null;
};

/**
 * Normalize, flatten and insert fields into a PDF document.
 */
const decorateAndSignPdf = async ({
  envelope,
  envelopeItem,
  envelopeItemFields,
  envelopeItemContents,
  isRejected,
  rejectionReason,
  pdfData,
  certificateDoc,
  auditLogDoc,
}: DecorateAndSignPdfOptions) => {
  // Solid Ten: the PDF part runs in a PDF child for a large document, with no database
  // (seal-pdf-bytes.ts, SEC3-M1); the content images are loaded here and decoded there.
  const contentImageBytes =
    envelope.internalVersion === 2 ? await loadContentImageBytes(envelopeItemContents) : new Map<string, Uint8Array>();

  const pdfBytes = await sealPdfIsolated({
    options: {
      envelope: {
        id: envelope.id,
        title: envelope.title,
        useLegacyFieldInsertion: envelope.useLegacyFieldInsertion,
        internalVersion: envelope.internalVersion,
      },
      fields: envelopeItemFields,
      contents: envelopeItemContents,
      isRejected,
      rejectionReason,
    },
    pdfData,
    certificatePdf: certificateDoc ? await certificateDoc.save() : null,
    auditLogPdf: auditLogDoc ? await auditLogDoc.save() : null,
    contentImageBytes,
  });

  const { name } = path.parse(envelopeItem.title);

  // Add suffix based on document status
  const suffix = isRejected ? '_rejected.pdf' : '_signed.pdf';

  const { documentData: newDocumentData } = await putPdfFileServerSide(
    {
      name: `${name}${suffix}`,
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(pdfBytes),
    },
    envelopeItem.documentData.initialData,
  );

  return {
    oldDocumentDataId: envelopeItem.documentData.id,
    newDocumentDataId: newDocumentData.id,
  };
};
