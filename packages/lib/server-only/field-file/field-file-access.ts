import { prisma } from '@documenso/prisma';
import type { DataContent, FieldFileUpload, Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import type { CertificateAttachedFile } from '../pdf/render-attached-files-certificate';
import { readFileFieldMeta } from './field-file-context';

/**
 * What a list of attached files shows. Never the bytes, never the storage key.
 */
export const fieldFileSummarySelect = {
  id: true,
  envelopeId: true,
  fieldId: true,
  recipientId: true,
  fileName: true,
  mimeType: true,
  size: true,
  sha256: true,
  uploaderName: true,
  uploaderEmail: true,
  createdAt: true,
} satisfies Prisma.FieldFileUploadSelect;

export type FieldFileSummary = Pick<
  FieldFileUpload,
  | 'id'
  | 'envelopeId'
  | 'fieldId'
  | 'recipientId'
  | 'fileName'
  | 'mimeType'
  | 'size'
  | 'sha256'
  | 'uploaderName'
  | 'uploaderEmail'
  | 'createdAt'
>;

/**
 * A recipient sees their own files, and the files of fields the sender marked "visible to
 * all recipients" on the same envelope.
 */
const canRecipientSeeUpload = (
  recipient: { id: number; envelopeId: string },
  upload: Pick<FieldFileUpload, 'recipientId' | 'envelopeId'> & { field: { fieldMeta: unknown } },
) =>
  upload.envelopeId === recipient.envelopeId &&
  (upload.recipientId === recipient.id || readFileFieldMeta(upload.field.fieldMeta).visibleToAllRecipients === true);

const getRecipientByToken = async (token: string) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: { id: true, envelopeId: true },
  });

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'This signing link is no longer valid.' });
  }

  return recipient;
};

/**
 * The files a signer can see on their envelope, for the signing page.
 */
export const listSignerFieldFiles = async ({ token }: { token: string }): Promise<FieldFileSummary[]> => {
  const recipient = await getRecipientByToken(token);

  const uploads = await prisma.fieldFileUpload.findMany({
    where: { envelopeId: recipient.envelopeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { ...fieldFileSummarySelect, field: { select: { fieldMeta: true } } },
  });

  return uploads
    .filter((upload) => canRecipientSeeUpload(recipient, upload))
    .map(({ field: _field, ...summary }) => summary);
};

/**
 * Load a file for download by a signing link token. Returns null when the token may not
 * see it, so the route answers 404 either way and does not reveal that the file exists.
 */
export const getSignerFieldFileForDownload = async ({
  token,
  fileId,
}: {
  token: string;
  fileId: string;
}): Promise<(FieldFileUpload & { dataContent: DataContent; downloader: FieldFileDownloader }) | null> => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: { id: true, envelopeId: true, name: true, email: true },
  });

  if (!recipient) {
    return null;
  }

  const upload = await prisma.fieldFileUpload.findFirst({
    where: { id: fileId, envelopeId: recipient.envelopeId },
    include: { dataContent: true, field: { select: { fieldMeta: true } } },
  });

  if (!upload || !canRecipientSeeUpload(recipient, upload)) {
    return null;
  }

  const { field: _field, ...rest } = upload;

  return { ...rest, downloader: { id: recipient.id, name: recipient.name, email: recipient.email } };
};

/**
 * Find an envelope the user may open through the normal document permission checks (team
 * membership and document visibility), or null.
 */
const findAccessibleEnvelopeId = async ({ userId, envelopeId }: { userId: number; envelopeId: string }) => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { teamId: true },
  });

  if (!envelope) {
    return null;
  }

  const access = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    userId,
    teamId: envelope.teamId,
    type: null,
  }).catch(() => null);

  if (!access) {
    return null;
  }

  const accessible = await prisma.envelope.findFirst({
    where: access.envelopeWhereInput,
    select: { id: true },
  });

  return accessible?.id ?? null;
};

/**
 * The files on an envelope, for the sender's document page.
 */
export const listEnvelopeFieldFiles = async ({
  userId,
  envelopeId,
}: {
  userId: number;
  envelopeId: string;
}): Promise<FieldFileSummary[]> => {
  const accessibleId = await findAccessibleEnvelopeId({ userId, envelopeId });

  if (!accessibleId) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Envelope not found' });
  }

  return await prisma.fieldFileUpload.findMany({
    where: { envelopeId: accessibleId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: fieldFileSummarySelect,
  });
};

/**
 * Load a file for download by a signed-in team member. Null when they may not open it.
 */
export const getTeamFieldFileForDownload = async ({
  userId,
  envelopeId,
  fileId,
}: {
  userId: number;
  envelopeId: string;
  fileId: string;
}) => {
  const accessibleId = await findAccessibleEnvelopeId({ userId, envelopeId });

  if (!accessibleId) {
    return null;
  }

  // Solid Ten Sign (S-H4): never serve a file of a deleted document from the team route.
  return await prisma.fieldFileUpload.findFirst({
    where: { id: fileId, envelopeId: accessibleId, envelope: { deletedAt: null } },
    include: { dataContent: true },
  });
};

type FieldFileDownloader = { id: number; name: string; email: string };

/**
 * Solid Ten Sign (S-H4): every download of an attached file is evidence. Writes
 * FIELD_FILE_DOWNLOADED with who (team member or recipient), the sign-in, IP and user agent.
 */
export const recordFieldFileDownload = async ({
  upload,
  via,
  user,
  authSessionId,
  downloadedByRecipientId,
  requestMetadata,
}: {
  upload: FieldFileUpload;
  via: 'TEAM' | 'RECIPIENT';
  user: { id?: number | null; name?: string | null; email?: string | null };
  authSessionId: string | null;
  downloadedByRecipientId: number | null;
  requestMetadata: RequestMetadata;
}) => {
  const field = await prisma.field.findUnique({ where: { id: upload.fieldId }, select: { secondaryId: true } });

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_DOWNLOADED,
      envelopeId: upload.envelopeId,
      user,
      requestMetadata,
      data: {
        fieldId: field?.secondaryId ?? String(upload.fieldId),
        recipientId: upload.recipientId,
        recipientEmail: upload.uploaderEmail,
        recipientName: upload.uploaderName,
        fileId: upload.id,
        fileName: upload.fileName,
        size: upload.size,
        sha256: upload.sha256,
        via,
        authSessionId,
        downloadedByRecipientId,
      },
    }),
  });
};

/**
 * The data contents that hold an envelope's attached files, for the retention purge.
 */
export const getEnvelopeFieldFileDataContentIds = async (envelopeId: string) => {
  const uploads = await prisma.fieldFileUpload.findMany({
    where: { envelopeId },
    select: { dataContentId: true },
  });

  return uploads.map((upload) => upload.dataContentId);
};

/**
 * The attached files for the completion certificate and webhooks, in upload order.
 */
export const getEnvelopeFieldFilesForCertificate = async (envelopeId: string) => {
  return await prisma.fieldFileUpload.findMany({
    where: { envelopeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      ...fieldFileSummarySelect,
      field: { select: { secondaryId: true, fieldMeta: true } },
    },
  });
};

/**
 * The attached files as the certificate lists them, with the IP address recorded on the
 * audit entry that stored each one.
 */
export const getCertificateAttachedFiles = async (envelopeId: string): Promise<CertificateAttachedFile[]> => {
  const uploads = await getEnvelopeFieldFilesForCertificate(envelopeId);

  if (uploads.length === 0) {
    return [];
  }

  const auditLogs = await prisma.documentAuditLog.findMany({
    where: { envelopeId, type: { in: ['FIELD_FILE_UPLOADED', 'FIELD_FILE_REPLACED'] } },
    select: { data: true, ipAddress: true },
  });

  const ipByFileId = new Map<string, string | null>();

  for (const log of auditLogs) {
    const data = log.data;

    const fileId =
      typeof data === 'object' && data !== null && !Array.isArray(data) && 'fileId' in data ? data.fileId : null;

    if (typeof fileId === 'string') {
      ipByFileId.set(fileId, log.ipAddress);
    }
  }

  return uploads.map((upload) => {
    const label = readFileFieldMeta(upload.field.fieldMeta).label?.trim();

    return {
      fileName: upload.fileName,
      size: upload.size,
      sha256: upload.sha256,
      uploaderName: upload.uploaderName,
      uploaderEmail: upload.uploaderEmail,
      createdAt: upload.createdAt,
      fieldLabel: label || null,
      ipAddress: ipByFileId.get(upload.id) ?? null,
    };
  });
};
