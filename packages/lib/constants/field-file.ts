import { env } from '../utils/env';

/**
 * Solid Ten: signer file upload ("Attach a file" fields).
 *
 * The feature is on unless `NEXT_PUBLIC_ST_FILE_UPLOAD_ENABLED` is 'false'. When it is
 * off, the editor hides the field and the server refuses uploads.
 */
export const IS_FILE_UPLOAD_ENABLED = () => env('NEXT_PUBLIC_ST_FILE_UPLOAD_ENABLED') !== 'false';

/**
 * The kinds of file a signer may attach. The sender can narrow this per field.
 */
export const FIELD_FILE_KINDS = ['pdf', 'png', 'jpeg', 'heic', 'docx', 'xlsx', 'txt', 'csv'] as const;

export type TFieldFileKind = (typeof FIELD_FILE_KINDS)[number];

export const FIELD_FILE_KIND_MIME_TYPES: Record<TFieldFileKind, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};

export const FIELD_FILE_KIND_EXTENSIONS: Record<TFieldFileKind, string[]> = {
  pdf: ['pdf'],
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  heic: ['heic', 'heif'],
  docx: ['docx'],
  xlsx: ['xlsx'],
  txt: ['txt'],
  csv: ['csv'],
};

export const FIELD_FILE_KIND_LABELS: Record<TFieldFileKind, string> = {
  pdf: 'PDF',
  png: 'PNG',
  jpeg: 'JPEG',
  heic: 'HEIC',
  docx: 'Word (DOCX)',
  xlsx: 'Excel (XLSX)',
  txt: 'Text (TXT)',
  csv: 'CSV',
};

export const FIELD_FILE_MAX_FILES_LIMIT = 10;

export const FIELD_FILE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export const FIELD_FILE_DEFAULT_ENVELOPE_MAX_BYTES = 50 * 1024 * 1024;

export const FIELD_FILE_MAX_FILE_NAME_LENGTH = 200;

const readPositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Largest single file, in bytes. Server only.
 */
export const getFieldFileMaxBytes = () =>
  readPositiveInt(process.env.NEXT_PRIVATE_ST_FILE_UPLOAD_MAX_BYTES, FIELD_FILE_DEFAULT_MAX_BYTES);

/**
 * Largest total of attached files on one envelope, in bytes. Server only.
 */
export const getFieldFileEnvelopeMaxBytes = () =>
  readPositiveInt(process.env.NEXT_PRIVATE_ST_FILE_UPLOAD_ENVELOPE_MAX_BYTES, FIELD_FILE_DEFAULT_ENVELOPE_MAX_BYTES);
