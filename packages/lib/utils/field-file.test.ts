import { describe, expect, it } from 'vitest';

import { FIELD_FILE_KINDS } from '../constants/field-file';
import {
  checkFieldFileLimits,
  detectFieldFileKind,
  formatFileSize,
  getFileInputAccept,
  readZipEntryNames,
  resolveAllowedFileKinds,
  resolveFieldMaxFiles,
  sanitizeFieldFileName,
} from './field-file';

/**
 * A minimal ZIP with stored (uncompressed) entries. CRCs are left at zero: the detector
 * only reads the central directory.
 */
const buildZip = (names: string[]) => {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];

  let offset = 0;

  for (const name of names) {
    const nameBytes = encoder.encode(name);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, names.length, true);
  endView.setUint16(10, names.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const all = [...localParts, ...centralParts, end];
  const result = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));

  let position = 0;

  for (const part of all) {
    result.set(part, position);
    position += part.length;
  }

  return result;
};

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, ...text('ftyp'), ...text(brand), 0, 0, 0, 0]);

describe('detectFieldFileKind', () => {
  it('detects the allowed kinds from their bytes', () => {
    expect(detectFieldFileKind(text('%PDF-1.7\n...'), 'a.pdf')).toMatchObject({ ok: true, kind: 'pdf' });
    expect(detectFieldFileKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'a.png')).toMatchObject({
      ok: true,
      kind: 'png',
      mimeType: 'image/png',
    });
    expect(detectFieldFileKind(bytes(0xff, 0xd8, 0xff, 0xe0, 0), 'a.jpg')).toMatchObject({ ok: true, kind: 'jpeg' });
    expect(detectFieldFileKind(ftyp('heic'), 'a.heic')).toMatchObject({ ok: true, kind: 'heic' });
    expect(detectFieldFileKind(ftyp('mif1'), 'a.heif')).toMatchObject({ ok: true, kind: 'heic' });
  });

  it('ignores the file name when the bytes say otherwise', () => {
    expect(detectFieldFileKind(text('%PDF-1.4'), 'photo.png')).toMatchObject({ ok: true, kind: 'pdf' });
  });

  it('tells DOCX and XLSX apart by their ZIP layout', () => {
    const docx = buildZip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const xlsx = buildZip(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']);

    expect(detectFieldFileKind(docx, 'a.docx')).toMatchObject({ ok: true, kind: 'docx' });
    expect(detectFieldFileKind(xlsx, 'a.xlsx')).toMatchObject({ ok: true, kind: 'xlsx' });
  });

  it('refuses plain ZIP archives, macro documents and other Office layouts', () => {
    expect(detectFieldFileKind(buildZip(['readme.txt', 'evil.exe']), 'a.docx')).toMatchObject({
      ok: false,
      reason: 'BLOCKED',
    });
    expect(
      detectFieldFileKind(buildZip(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin']), 'a.docx'),
    ).toMatchObject({ ok: false, reason: 'BLOCKED', detail: 'Office file with macros' });
    expect(detectFieldFileKind(buildZip(['[Content_Types].xml', 'ppt/presentation.xml']), 'a.pptx')).toMatchObject({
      ok: false,
    });
    expect(detectFieldFileKind(bytes(0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)), 'a.zip')).toMatchObject({
      ok: false,
      reason: 'BLOCKED',
    });
  });

  it('refuses a ZIP whose central directory is broken', () => {
    const broken = buildZip(['[Content_Types].xml', 'word/document.xml']).slice(0, 40);

    expect(detectFieldFileKind(broken, 'a.docx')).toMatchObject({ ok: false, reason: 'BLOCKED' });
  });

  it('refuses executables and archives', () => {
    expect(detectFieldFileKind(bytes(0x4d, 0x5a, 0x90, 0), 'setup.pdf')).toMatchObject({
      ok: false,
      reason: 'BLOCKED',
      detail: 'Windows executable',
    });
    expect(detectFieldFileKind(bytes(0x7f, 0x45, 0x4c, 0x46, 2), 'a.txt')).toMatchObject({ ok: false });
    expect(detectFieldFileKind(bytes(0xcf, 0xfa, 0xed, 0xfe, 7), 'a.txt')).toMatchObject({ ok: false });
    expect(detectFieldFileKind(bytes(0x1f, 0x8b, 8, 0), 'a.csv')).toMatchObject({ ok: false });
    expect(detectFieldFileKind(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0), 'a.txt')).toMatchObject({ ok: false });
    expect(detectFieldFileKind(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), 'a.txt')).toMatchObject({ ok: false });
    expect(detectFieldFileKind(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 'a.doc')).toMatchObject({
      ok: false,
    });
  });

  it('refuses HTML, SVG and XML even when named as text', () => {
    expect(detectFieldFileKind(text('<!DOCTYPE html><script>alert(1)</script>'), 'a.txt')).toMatchObject({
      ok: false,
      reason: 'BLOCKED',
    });
    expect(detectFieldFileKind(text('\uFEFF  <svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.csv')).toMatchObject({
      ok: false,
    });
    expect(detectFieldFileKind(text('<?xml version="1.0"?><a/>'), 'a.txt')).toMatchObject({ ok: false });
  });

  it('refuses other media containers', () => {
    expect(detectFieldFileKind(ftyp('isom'), 'movie.heic')).toMatchObject({ ok: false, reason: 'BLOCKED' });
  });

  it('accepts UTF-8 text and uses the name only to tell CSV from TXT', () => {
    expect(detectFieldFileKind(text('name,amount\nAnn,12\n'), 'list.CSV')).toMatchObject({
      ok: true,
      kind: 'csv',
      mimeType: 'text/csv',
    });
    expect(detectFieldFileKind(text('Hello\tthere\r\nçà ü 😀'), 'notes')).toMatchObject({ ok: true, kind: 'txt' });
  });

  it('refuses binary data and invalid UTF-8', () => {
    expect(detectFieldFileKind(bytes(0x48, 0x00, 0x49), 'a.txt')).toMatchObject({ ok: false, reason: 'UNKNOWN' });
    expect(detectFieldFileKind(bytes(0xc3, 0x28), 'a.txt')).toMatchObject({ ok: false, reason: 'UNKNOWN' });
  });

  it('refuses an empty file', () => {
    expect(detectFieldFileKind(new Uint8Array(0), 'a.pdf')).toMatchObject({ ok: false, reason: 'EMPTY' });
  });
});

describe('readZipEntryNames', () => {
  it('reads the entry names', () => {
    expect(readZipEntryNames(buildZip(['a.txt', 'b/c.xml']))).toEqual(['a.txt', 'b/c.xml']);
  });

  it('returns null for bytes that are not a ZIP', () => {
    expect(readZipEntryNames(text('no zip here at all, just text.'))).toBeNull();
  });
});

describe('resolveAllowedFileKinds', () => {
  it('allows every kind when the sender did not narrow it', () => {
    expect(resolveAllowedFileKinds(undefined)).toEqual([...FIELD_FILE_KINDS]);
    expect(resolveAllowedFileKinds([])).toEqual([...FIELD_FILE_KINDS]);
  });

  it('keeps the sender choice and drops unknown values', () => {
    expect(resolveAllowedFileKinds(['png', 'pdf', 'exe'])).toEqual(['pdf', 'png']);
  });

  it('falls back to every kind when nothing known is left', () => {
    expect(resolveAllowedFileKinds(['exe', 'svg'])).toEqual([...FIELD_FILE_KINDS]);
  });

  it('builds an accept attribute for the picker', () => {
    expect(getFileInputAccept(['pdf', 'jpeg'])).toBe('.pdf,application/pdf,.jpg,.jpeg,image/jpeg');
  });
});

describe('checkFieldFileLimits', () => {
  const base = {
    fileSize: 1000,
    maxFileBytes: 10_000,
    fieldFileCount: 0,
    maxFiles: 1,
    envelopeBytes: 0,
    maxEnvelopeBytes: 50_000,
  };

  it('passes within the limits', () => {
    expect(checkFieldFileLimits(base)).toEqual({ ok: true });
    expect(checkFieldFileLimits({ ...base, fileSize: 10_000 })).toEqual({ ok: true });
  });

  it('refuses a file over the size limit', () => {
    expect(checkFieldFileLimits({ ...base, fileSize: 10_001 })).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
  });

  it('refuses one file too many', () => {
    expect(checkFieldFileLimits({ ...base, fieldFileCount: 1 })).toMatchObject({
      ok: false,
      reason: 'TOO_MANY_FILES',
      message: 'This field takes one file.',
    });
    expect(checkFieldFileLimits({ ...base, fieldFileCount: 2, maxFiles: 3 })).toEqual({ ok: true });
    expect(checkFieldFileLimits({ ...base, fieldFileCount: 3, maxFiles: 3 })).toMatchObject({
      ok: false,
      message: 'This field takes up to 3 files.',
    });
  });

  it('refuses a file that would fill the envelope past its cap', () => {
    expect(checkFieldFileLimits({ ...base, envelopeBytes: 49_500 })).toMatchObject({
      ok: false,
      reason: 'ENVELOPE_FULL',
    });
    expect(checkFieldFileLimits({ ...base, envelopeBytes: 49_000 })).toEqual({ ok: true });
  });

  it('defaults the file count to one', () => {
    expect(resolveFieldMaxFiles(undefined)).toBe(1);
    expect(resolveFieldMaxFiles(0)).toBe(1);
    expect(resolveFieldMaxFiles(1.5)).toBe(1);
    expect(resolveFieldMaxFiles(4)).toBe(4);
  });
});

describe('sanitizeFieldFileName', () => {
  it('keeps a valid extension of the real kind', () => {
    expect(sanitizeFieldFileName('Tax Return 2025.PDF', 'pdf')).toBe('Tax Return 2025.pdf');
    expect(sanitizeFieldFileName('photo.jpeg', 'jpeg')).toBe('photo.jpeg');
  });

  it('adds the right extension when the name lies about the kind', () => {
    expect(sanitizeFieldFileName('invoice.pdf.exe', 'pdf')).toBe('invoice.pdf.exe.pdf');
    expect(sanitizeFieldFileName('scan', 'png')).toBe('scan.png');
  });

  it('drops path parts, control and bidi characters', () => {
    expect(sanitizeFieldFileName('C:\\Users\\me\\..\\secret.txt', 'txt')).toBe('secret.txt');
    expect(sanitizeFieldFileName('../../etc/passwd', 'txt')).toBe('passwd.txt');
    expect(sanitizeFieldFileName('a\r\nb\u0000c.pdf', 'pdf')).toBe('a b c.pdf');
    expect(sanitizeFieldFileName('report\u202Efdp.exe', 'pdf')).toBe('report fdp.exe.pdf');
    expect(sanitizeFieldFileName('"quoted" <name>.csv', 'csv')).toBe('quoted name.csv');
  });

  it('drops leading dots so the file is never hidden', () => {
    expect(sanitizeFieldFileName('.htaccess.txt', 'txt')).toBe('htaccess.txt');
  });

  it('falls back to a default name', () => {
    expect(sanitizeFieldFileName('', 'pdf')).toBe('file.pdf');
    expect(sanitizeFieldFileName('.pdf', 'pdf')).toBe('file.pdf');
    expect(sanitizeFieldFileName('\u0000\u0001', 'csv')).toBe('file.csv');
  });

  it('truncates long names without splitting a surrogate pair', () => {
    const name = sanitizeFieldFileName(`a${'😀'.repeat(500)}.pdf`, 'pdf');

    expect(name.isWellFormed()).toBe(true);
    expect(name.length).toBeLessThanOrEqual(204);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('formatFileSize', () => {
  it('formats bytes for people', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 MB');
  });
});
