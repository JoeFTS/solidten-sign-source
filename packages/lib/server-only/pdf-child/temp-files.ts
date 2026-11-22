import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Solid Ten: temp files of the PDF child. Documents (signed contracts among them) pass through
 * here, so: one private parent directory (0700), files written 0600, each operation's directory
 * removed when the operation ends (success, failure, timeout or a dead child), and leftovers from
 * a process that died removed at start (sweepPdfTempFiles).
 */
export const PDF_TEMP_ROOT_NAME = 'solidten-pdf';

/**
 * The parent folder: NEXT_PRIVATE_ST_PDF_TEMP_DIR when set (a container with a small or
 * read-only /tmp), else the system temp folder.
 */
export const getPdfTempRoot = () => path.join(process.env.NEXT_PRIVATE_ST_PDF_TEMP_DIR || tmpdir(), PDF_TEMP_ROOT_NAME);

/** File-system errors that mean "the temp folder cannot be used" (full, read-only, no access). */
const TEMP_FOLDER_ERROR_CODES = new Set(['ENOSPC', 'EROFS', 'EACCES', 'EPERM', 'EDQUOT', 'ENOENT', 'ENOTDIR']);

export const isTempFolderError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  TEMP_FOLDER_ERROR_CODES.has(String((error as { code?: unknown }).code));

export const createPdfTempDir = async () => {
  const root = getPdfTempRoot();

  await mkdir(root, { recursive: true, mode: 0o700 });

  return await mkdtemp(path.join(root, 'op-'));
};

export const writePrivateFile = async (filePath: string, data: Uint8Array) =>
  await writeFile(filePath, data, { mode: 0o600 });

export const removePdfTempDir = async (dir: string) => await rm(dir, { recursive: true, force: true });

/**
 * Remove operation directories older than `olderThanMs` (default: longer than any child may run).
 * Another app instance on the same host may have a younger one in use; those are kept.
 */
export const sweepPdfTempFiles = async ({ olderThanMs = 15 * 60_000, now = Date.now() } = {}) => {
  const root = getPdfTempRoot();
  let removed = 0;

  const entries = await readdir(root).catch(() => [] as string[]);

  for (const entry of entries) {
    const dir = path.join(root, entry);
    const info = await stat(dir).catch(() => null);

    if (info && now - info.mtimeMs > olderThanMs) {
      await removePdfTempDir(dir);
      removed++;
    }
  }

  if (removed > 0) {
    console.warn(`[PDF]: Removed ${removed} leftover PDF temp folder(s) from ${root}`);
  }

  return removed;
};
