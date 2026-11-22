import {
  FIELD_FILE_KIND_EXTENSIONS,
  FIELD_FILE_KIND_MIME_TYPES,
  FIELD_FILE_KINDS,
  FIELD_FILE_MAX_FILE_NAME_LENGTH,
  type TFieldFileKind,
} from '../constants/field-file';

/**
 * Solid Ten: pure helpers for "Attach a file" fields. No database, no storage, so they
 * can be unit tested and shared by the server and the browser.
 */

export type FieldFileDetection =
  | { ok: true; kind: TFieldFileKind; mimeType: string }
  | { ok: false; reason: 'EMPTY' | 'BLOCKED' | 'UNKNOWN'; detail: string };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_ARCHIVE = [0x50, 0x4b, 0x05, 0x06];

/**
 * Signatures that are refused outright, with a name for the log. Anything that is not on
 * the allowlist is refused anyway; these only give a clearer reason.
 */
const BLOCKED_SIGNATURES: { name: string; signature: number[]; offset?: number }[] = [
  { name: 'Windows executable', signature: [0x4d, 0x5a] },
  { name: 'ELF executable', signature: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O executable', signature: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'Mach-O executable', signature: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'Mach-O executable', signature: [0xce, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O executable', signature: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O universal binary or Java class', signature: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'RAR archive', signature: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { name: '7-Zip archive', signature: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: 'gzip archive', signature: [0x1f, 0x8b] },
  { name: 'bzip2 archive', signature: [0x42, 0x5a, 0x68] },
  { name: 'xz archive', signature: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { name: 'zstd archive', signature: [0x28, 0xb5, 0x2f, 0xfd] },
  { name: 'tar archive', signature: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257 },
  { name: 'Microsoft compound file (old Office, MSI)', signature: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { name: 'WebAssembly module', signature: [0x00, 0x61, 0x73, 0x6d] },
];

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/**
 * Read the entry names from a ZIP file's central directory. Returns null when the bytes
 * are not a well formed ZIP.
 */
export const readZipEntryNames = (bytes: Uint8Array): string[] | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end of central directory record is at least 22 bytes and may be followed by a
  // comment of up to 65535 bytes.
  const searchStart = Math.max(0, bytes.length - 22 - 0xffff);

  let endOfDirectory = -1;

  for (let index = bytes.length - 22; index >= searchStart; index--) {
    if (view.getUint32(index, true) === 0x06054b50) {
      endOfDirectory = index;
      break;
    }
  }

  if (endOfDirectory < 0) {
    return null;
  }

  const entryCount = view.getUint16(endOfDirectory + 10, true);
  const directoryOffset = view.getUint32(endOfDirectory + 16, true);

  // A ZIP64 archive marks these as 0xFFFF / 0xFFFFFFFF. Office never writes ZIP64 for
  // files of the sizes allowed here, so it is refused.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    return null;
  }

  const names: string[] = [];

  let offset = directoryOffset;

  for (let entry = 0; entry < entryCount; entry++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      return null;
    }

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);

    if (offset + 46 + nameLength > bytes.length) {
      return null;
    }

    names.push(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
};

/**
 * An Office Open XML file (DOCX, XLSX) is a ZIP with a fixed layout. Every other ZIP is an
 * archive and is refused, as is a document that carries macros.
 */
const detectOfficeKind = (bytes: Uint8Array): FieldFileDetection => {
  const names = readZipEntryNames(bytes);

  if (!names) {
    return { ok: false, reason: 'BLOCKED', detail: 'Malformed or unsupported ZIP file' };
  }

  const lowerNames = new Set(names.map((name) => name.toLowerCase()));

  if (!lowerNames.has('[content_types].xml')) {
    return { ok: false, reason: 'BLOCKED', detail: 'ZIP archive' };
  }

  if (names.some((name) => name.toLowerCase().endsWith('vbaproject.bin'))) {
    return { ok: false, reason: 'BLOCKED', detail: 'Office file with macros' };
  }

  if (lowerNames.has('word/document.xml')) {
    return { ok: true, kind: 'docx', mimeType: FIELD_FILE_KIND_MIME_TYPES.docx };
  }

  if (lowerNames.has('xl/workbook.xml')) {
    return { ok: true, kind: 'xlsx', mimeType: FIELD_FILE_KIND_MIME_TYPES.xlsx };
  }

  return { ok: false, reason: 'BLOCKED', detail: 'Office file of an unsupported kind' };
};

/**
 * Plain text: valid UTF-8 with no control characters other than tab, line feed, form
 * feed and carriage return. Text that starts like markup (HTML, SVG, XML) is refused, so
 * a browser can never be talked into rendering it.
 */
const detectText = (bytes: Uint8Array, fileName: string): FieldFileDetection => {
  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'UNKNOWN', detail: 'Not UTF-8 text' };
  }

  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
  if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text)) {
    return { ok: false, reason: 'UNKNOWN', detail: 'Binary data' };
  }

  const start = text.replace(/^﻿/, '').trimStart().slice(0, 256).toLowerCase();

  if (start.startsWith('<')) {
    return { ok: false, reason: 'BLOCKED', detail: 'Markup (HTML, SVG or XML)' };
  }

  const kind: TFieldFileKind = getFileExtension(fileName) === 'csv' ? 'csv' : 'txt';

  return { ok: true, kind, mimeType: FIELD_FILE_KIND_MIME_TYPES[kind] };
};

/**
 * Find the kind of a file from its bytes. The declared content type and the file name are
 * not trusted; the name only tells CSV apart from plain text.
 */
export const detectFieldFileKind = (bytes: Uint8Array, fileName: string): FieldFileDetection => {
  if (bytes.length === 0) {
    return { ok: false, reason: 'EMPTY', detail: 'The file is empty' };
  }

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { ok: true, kind: 'pdf', mimeType: FIELD_FILE_KIND_MIME_TYPES.pdf };
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ok: true, kind: 'png', mimeType: FIELD_FILE_KIND_MIME_TYPES.png };
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { ok: true, kind: 'jpeg', mimeType: FIELD_FILE_KIND_MIME_TYPES.jpeg };
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);

    if (HEIF_BRANDS.has(brand)) {
      return { ok: true, kind: 'heic', mimeType: FIELD_FILE_KIND_MIME_TYPES.heic };
    }

    return { ok: false, reason: 'BLOCKED', detail: `Media container (${brand})` };
  }

  if (startsWith(bytes, ZIP_LOCAL_HEADER)) {
    return detectOfficeKind(bytes);
  }

  if (startsWith(bytes, ZIP_EMPTY_ARCHIVE)) {
    return { ok: false, reason: 'BLOCKED', detail: 'ZIP archive' };
  }

  for (const blocked of BLOCKED_SIGNATURES) {
    if (startsWith(bytes, blocked.signature, blocked.offset ?? 0)) {
      return { ok: false, reason: 'BLOCKED', detail: blocked.name };
    }
  }

  return detectText(bytes, fileName);
};

/**
 * The kinds a field accepts: the sender's choice when it is set, otherwise all of them.
 * Unknown values in stored meta are ignored.
 */
export const resolveAllowedFileKinds = (allowedFileTypes?: readonly string[] | null): TFieldFileKind[] => {
  const known = (allowedFileTypes ?? []).filter((kind): kind is TFieldFileKind =>
    FIELD_FILE_KINDS.some((candidate) => candidate === kind),
  );

  return known.length > 0 ? FIELD_FILE_KINDS.filter((kind) => known.includes(kind)) : [...FIELD_FILE_KINDS];
};

/**
 * The `accept` attribute for a file input, so the picker shows the right files. Only a
 * convenience: the server checks the bytes.
 */
export const getFileInputAccept = (kinds: TFieldFileKind[]) =>
  kinds
    .flatMap((kind) => [...FIELD_FILE_KIND_EXTENSIONS[kind].map((ext) => `.${ext}`), FIELD_FILE_KIND_MIME_TYPES[kind]])
    .join(',');

export const getFileExtension = (fileName: string) => {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName.trim());

  return match ? match[1].toLowerCase() : '';
};

/**
 * A naive slice can split a surrogate pair and leave a lone surrogate, which Postgres
 * jsonb rejects.
 */
const truncateWithoutSplittingSurrogates = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  const lastCodeUnit = value.charCodeAt(maxLength - 1);

  const isHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;

  return value.slice(0, isHighSurrogate ? maxLength - 1 : maxLength);
};

/**
 * Make a file name safe to store, show and send in a Content-Disposition header. Path
 * parts and control characters go; the extension is set to one that matches the real
 * kind of the file, so "invoice.pdf.exe" holding a PDF becomes "invoice.pdf.exe.pdf".
 */
export const sanitizeFieldFileName = (fileName: string, kind: TFieldFileKind) => {
  const validExtensions = FIELD_FILE_KIND_EXTENSIONS[kind];

  const lastPathPart = fileName.split(/[\\/]/).pop() ?? '';

  let baseName = lastPathPart
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/["<>:|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const currentExtension = getFileExtension(baseName);

  let extension = validExtensions[0];

  if (validExtensions.includes(currentExtension)) {
    extension = currentExtension;
    baseName = baseName.slice(0, -(currentExtension.length + 1));
  }

  // Leading dots go after the extension is split off, so ".pdf" is a nameless PDF.
  baseName = baseName.replace(/^[.\s]+/, '').trim();

  const truncated = truncateWithoutSplittingSurrogates(baseName, FIELD_FILE_MAX_FILE_NAME_LENGTH).trim();

  return `${truncated === '' ? 'file' : truncated}.${extension}`;
};

export type FieldFileLimitCheck =
  | { ok: true }
  | { ok: false; reason: 'TOO_LARGE' | 'TOO_MANY_FILES' | 'ENVELOPE_FULL'; message: string };

export type CheckFieldFileLimitsOptions = {
  fileSize: number;
  maxFileBytes: number;
  /** Files already on the field, not counting one that this upload replaces. */
  fieldFileCount: number;
  maxFiles: number;
  /** Bytes already stored on the envelope, not counting one that this upload replaces. */
  envelopeBytes: number;
  maxEnvelopeBytes: number;
};

export const checkFieldFileLimits = ({
  fileSize,
  maxFileBytes,
  fieldFileCount,
  maxFiles,
  envelopeBytes,
  maxEnvelopeBytes,
}: CheckFieldFileLimitsOptions): FieldFileLimitCheck => {
  if (fileSize > maxFileBytes) {
    return {
      ok: false,
      reason: 'TOO_LARGE',
      message: `The file is larger than ${formatFileSize(maxFileBytes)}.`,
    };
  }

  if (fieldFileCount + 1 > maxFiles) {
    return {
      ok: false,
      reason: 'TOO_MANY_FILES',
      message: maxFiles === 1 ? 'This field takes one file.' : `This field takes up to ${maxFiles} files.`,
    };
  }

  if (envelopeBytes + fileSize > maxEnvelopeBytes) {
    return {
      ok: false,
      reason: 'ENVELOPE_FULL',
      message: `The files on this document cannot be larger than ${formatFileSize(maxEnvelopeBytes)} in total.`,
    };
  }

  return { ok: true };
};

export const resolveFieldMaxFiles = (maxFiles?: number | null) =>
  Number.isInteger(maxFiles) && maxFiles !== null && maxFiles !== undefined && maxFiles > 0 ? maxFiles : 1;

/**
 * The text stored in the field's customText and drawn in the field box: the file names.
 */
export const toFieldFileCustomText = (fileNames: string[]) => fileNames.join(', ');

export const formatFileSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];

  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unitIndex]}`;
};

/**
 * Download links. The token link works for the uploader (and other recipients when the
 * field is visible to all); the envelope link needs a signed-in team member.
 */
export const getFieldFileTokenDownloadPath = (token: string, fileId: string) =>
  `/api/files/token/${encodeURIComponent(token)}/field-file/${encodeURIComponent(fileId)}`;

export const getFieldFileEnvelopeDownloadPath = (envelopeId: string, fileId: string) =>
  `/api/files/envelope/${encodeURIComponent(envelopeId)}/field-file/${encodeURIComponent(fileId)}`;
