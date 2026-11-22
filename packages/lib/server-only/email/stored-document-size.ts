import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { DocumentDataType } from '@prisma/client';

import { getPresignGetUrl } from '../../universal/upload/server-actions';

/**
 * Solid Ten: the size of stored documents, without loading them (LD2-B).
 *
 * The completion email used to load every file before it decided anything; a 36 MB document
 * then ran the heap out while the email was built. The size now comes from the database
 * (octet_length of the stored text) or, for S3, from a one-byte ranged GET.
 */
export const getBytesFromStoredLength = (type: DocumentDataType | string, storedLength: number) => {
  if (type === DocumentDataType.BYTES_64) {
    // Four base64 characters hold three bytes.
    return Math.floor((storedLength * 3) / 4);
  }

  return storedLength;
};

const getS3ObjectBytes = async (key: string): Promise<number | null> => {
  try {
    const { url } = await getPresignGetUrl(key);
    const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });

    await response.body?.cancel();

    const total = response.headers.get('content-range')?.split('/')[1];

    return total && total !== '*' ? Number(total) : null;
  } catch {
    return null;
  }
};

/**
 * Total bytes of the given stored documents. Returns null when a size cannot be read; callers
 * treat that as "too large to attach".
 */
export const getStoredDocumentBytes = async (documentDataIds: string[]): Promise<number | null> => {
  if (documentDataIds.length === 0) {
    return 0;
  }

  const rows = await prisma.$queryRaw<Array<{ type: string; key: string | null; length: number }>>`
    SELECT "type"::text AS "type",
           CASE WHEN "type" = 'S3_PATH' THEN "data" ELSE NULL END AS "key",
           octet_length("data")::int AS "length"
    FROM "DocumentData"
    WHERE "id" = ANY(${documentDataIds}::text[])
  `;

  let total = 0;

  for (const row of rows) {
    const bytes =
      row.type === DocumentDataType.S3_PATH && row.key
        ? await getS3ObjectBytes(row.key)
        : getBytesFromStoredLength(row.type, row.length);

    if (bytes === null) {
      return null;
    }

    total += bytes;
  }

  return total;
};

/** Total stored bytes of an envelope's documents, for deciding whether work is heavy. */
export const getEnvelopeStoredBytes = async (envelopeWhere: Prisma.EnvelopeWhereInput) => {
  const items = await prisma.envelopeItem.findMany({
    where: { envelope: envelopeWhere },
    select: { documentDataId: true },
  });

  return (await getStoredDocumentBytes(items.map((item) => item.documentDataId))) ?? Number.MAX_SAFE_INTEGER;
};
