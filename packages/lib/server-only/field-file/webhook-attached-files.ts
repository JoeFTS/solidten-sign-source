import { prisma } from '@documenso/prisma';

import type { TWebhookAttachedFile } from '../../types/webhook-payload';
import { logger } from '../../utils/logger';

/**
 * Solid Ten: add the metadata of the files signers attached to a document webhook
 * payload, under `attachedFiles`. Never the bytes, never a download link. Payloads of
 * documents without attached files are left exactly as they were.
 */
export const addAttachedFilesToWebhookData = async (data: Record<string, unknown>) => {
  const envelopeId = data.envelopeId;

  if (typeof envelopeId !== 'string' || 'attachedFiles' in data) {
    return data;
  }

  try {
    const uploads = await prisma.fieldFileUpload.findMany({
      where: { envelopeId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { field: { select: { secondaryId: true } } },
    });

    if (uploads.length === 0) {
      return data;
    }

    const attachedFiles: TWebhookAttachedFile[] = uploads.map((upload) => ({
      id: upload.id,
      fieldId: upload.field.secondaryId,
      recipientId: upload.recipientId,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      sha256: upload.sha256,
      uploadedBy: { name: upload.uploaderName, email: upload.uploaderEmail },
      uploadedAt: upload.createdAt.toISOString(),
    }));

    return { ...data, attachedFiles };
  } catch (err) {
    // The webhook still goes out without the list rather than not at all.
    logger.error({ msg: '[FIELD_FILE] Could not add attached files to a webhook', envelopeId, err });

    return data;
  }
};
