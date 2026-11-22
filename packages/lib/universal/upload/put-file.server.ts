import { env } from '@documenso/lib/utils/env';
import { DocumentDataType } from '@prisma/client';
import { match } from 'ts-pattern';
import { createDocumentData } from '../../server-only/document-data/create-document-data';
import { runHeavyPdfWork } from '../../server-only/pdf/heavy-pdf-queue';
import { inspectPdfIsolated, normalizePdfIsolated } from '../../server-only/pdf-child/isolated-pdf';
import { encodeBase64 } from '../base64';
import { uploadS3File } from './server-actions';

type File = {
  name: string;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer | Uint8Array>;
};

/**
 * Uploads a document file to the appropriate storage location and creates
 * a document data record.
 */
export const putPdfFileServerSide = async (file: File, initialData?: string) => {
  const arrayBuffer = await file.arrayBuffer();

  // Solid Ten (AUD-2 follow-up): read in the PDF child; it refuses an unreadable or encrypted file
  // (INVALID_DOCUMENT_FILE): encrypted documents stay refused.
  const { pageCount } = await inspectPdfIsolated(new Uint8Array(arrayBuffer));

  if (!file.name.endsWith('.pdf')) {
    file.name = `${file.name}.pdf`;
  }

  const { type, data } = await putFileServerSide(file);

  const createdData = await createDocumentData({ type, data, initialData });

  return {
    documentData: createdData,
    filePageCount: pageCount,
  };
};

type PutNormalizedPdfFileOptions = {
  flattenForm?: boolean;
  /** Solid Ten (AUD-5): filled in the PDF child, before normalising. */
  formValues?: Record<string, string | number | boolean> | null;
  initialData?: string;
};

/**
 * Uploads a pdf file and normalizes it.
 */
export const putNormalizedPdfFileServerSide = async (
  file: File,
  { initialData, ...normalizePdfOptions }: PutNormalizedPdfFileOptions = {},
) => {
  const buffer = Buffer.from(await file.arrayBuffer());

  // Solid Ten: a large file is normalised alone among heavy PDF work (LD2-A), in its own
  // process (LD3-H1, LD3-M1).
  const { pdf: normalized, pageCount } = await runHeavyPdfWork(
    buffer.byteLength,
    async () => await normalizePdfIsolated(buffer, normalizePdfOptions),
  );

  const fileName = file.name.endsWith('.pdf') ? file.name : `${file.name}.pdf`;

  const uploadedFile = await putFileServerSide({
    name: fileName,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(normalized),
  });

  const documentData = await createDocumentData({
    type: uploadedFile.type,
    data: uploadedFile.data,
    initialData,
  });

  return {
    documentData,
    filePageCount: pageCount,
  };
};

/**
 * Solid Ten: store a PDF that was already checked and normalised (its page count known), without
 * loading it again in this process.
 */
export const putPreparedPdfFileServerSide = async ({
  name,
  pdf,
  pageCount,
  initialData,
}: {
  name: string;
  pdf: Buffer;
  pageCount: number;
  initialData?: string;
}) => {
  const uploadedFile = await putFileServerSide({
    name: name.endsWith('.pdf') ? name : `${name}.pdf`,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(pdf),
  });

  const documentData = await createDocumentData({ type: uploadedFile.type, data: uploadedFile.data, initialData });

  return { documentData, filePageCount: pageCount };
};

/**
 * Uploads a file to the appropriate storage location.
 */
export const putFileServerSide = async (file: File) => {
  const NEXT_PUBLIC_UPLOAD_TRANSPORT = env('NEXT_PUBLIC_UPLOAD_TRANSPORT');

  return await match(NEXT_PUBLIC_UPLOAD_TRANSPORT)
    .with('s3', async () => putFileInObjectStorage(file))
    .with('azure-blob', async () => putFileInObjectStorage(file))
    .otherwise(async () => putFileInDatabase(file));
};

const putFileInDatabase = async (file: File) => {
  const contents = await file.arrayBuffer();

  const binaryData = new Uint8Array(contents);

  const asciiData = encodeBase64(binaryData);

  return {
    type: DocumentDataType.BYTES_64,
    data: asciiData,
  };
};

const putFileInObjectStorage = async (file: File) => {
  const buffer = await file.arrayBuffer();

  const blob = new Blob([buffer], { type: file.type });

  const newFile = new File([blob], file.name, {
    type: file.type,
  });

  const { key } = await uploadS3File(newFile);

  return {
    type: DocumentDataType.S3_PATH,
    data: key,
  };
};
