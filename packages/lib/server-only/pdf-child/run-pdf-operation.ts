import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../../errors/app-error';
import { env } from '../../utils/env';
import { buildPdfChildEnv } from './child-env';
import { fallBackToAppProcess, type TPdfChildFallbackStats } from './pdf-child-fallback';
import { runPdfBytesOperation, runPdfOperation, type TPdfOperation, type TPdfOperationResult } from './pdf-operations';
import { createPdfTempDir, getPdfTempRoot, isTempFolderError, removePdfTempDir, writePrivateFile } from './temp-files';

/**
 * Solid Ten: run a heavy PDF operation in a short-lived child process (LD3-H1, LD3-M1).
 *
 * PDF work on the main thread blocked the event loop for 5 to 10 s and left 1.4 to 2.2 GB of
 * memory behind after a few large documents; one more large upload then pushed the app past its
 * container cap. In a child the work blocks only the child, and all of its memory is returned
 * when it exits.
 *
 * - Data goes by temp file, never through IPC.
 * - The child gets its own heap ceiling (NEXT_PRIVATE_ST_PDF_CHILD_MAX_MB, default 1536) and a
 *   timeout (NEXT_PRIVATE_ST_PDF_CHILD_TIMEOUT_MS, default 5 minutes), and asks the kernel to
 *   kill it first when memory runs out. A child that dies gives DOCUMENT_TOO_COMPLEX (422); the
 *   app keeps running.
 * - Fallback: when no child entry is found or it cannot start, the operation runs in this
 *   process, as before, with a warning (counted in getPdfChildStats).
 * - NEXT_PRIVATE_ST_PDF_CHILD_DISABLED=true runs everything in process.
 */
export const DEFAULT_PDF_CHILD_MAX_MB = 1536;
export const DEFAULT_PDF_CHILD_TIMEOUT_MS = 5 * 60_000;

export const DOCUMENT_TOO_COMPLEX_MESSAGE = 'This document is too large or complex to process.';

export type TPdfChildStats = TPdfChildFallbackStats & {
  runs: number;
  failures: number;
  lastStartupMs: number | null;
  /** Operations done in memory because the temp folder could not be written. */
  tempFolderFailures: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __solidten_pdf_children__: Set<import('node:child_process').ChildProcess> | undefined;
  // eslint-disable-next-line no-var
  var __solidten_pdf_child_stats__: TPdfChildStats | undefined;
}

// Solid Ten: children still running, so a shutdown can stop them (graceful-shutdown.ts).
const liveChildren = () => {
  globalThis.__solidten_pdf_children__ ??= new Set();

  return globalThis.__solidten_pdf_children__;
};

export const killPdfChildren = () => {
  for (const child of liveChildren()) {
    child.kill('SIGKILL');
  }
};

export const getPdfChildStats = (): TPdfChildStats => {
  if (!globalThis.__solidten_pdf_child_stats__) {
    globalThis.__solidten_pdf_child_stats__ = {
      runs: 0,
      fallbacks: 0,
      failures: 0,
      lastStartupMs: null,
      tempFolderFailures: 0,
      lastFallbackAt: null,
      lastFallbackReason: null,
      refusals: 0,
    };
  }

  return globalThis.__solidten_pdf_child_stats__;
};

const readPositive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Solid Ten (LD4-L3): the caller gets the plain message; the detail (a signal, a timeout) goes to
// the log only.
export const createDocumentTooComplexError = (detail: string) => {
  console.error(`[PDF]: The PDF process failed: ${detail}`);

  return new AppError('DOCUMENT_TOO_COMPLEX', {
    message: DOCUMENT_TOO_COMPLEX_MESSAGE,
    userMessage: DOCUMENT_TOO_COMPLEX_MESSAGE,
    statusCode: 422,
  });
};

export type TPdfChildCommand = { modulePath: string; args: string[]; execArgv: string[] };

/**
 * How to start the child. Built server: the rollup output of server/pdf-child.ts. Dev: the
 * TypeScript entry through vite-node (it compiles TypeScript and lingui macros). Returns null when
 * no entry is found (the caller runs in process).
 */
export const resolvePdfChildCommand = (): TPdfChildCommand | null => {
  const maxMb = readPositive(env('NEXT_PRIVATE_ST_PDF_CHILD_MAX_MB'), DEFAULT_PDF_CHILD_MAX_MB);
  const execArgv = [`--max-old-space-size=${maxMb}`];
  const cwd = process.cwd();

  const builtCandidates = [
    path.join(cwd, 'build/server/hono/server/pdf-child.js'),
    path.join(cwd, 'apps/remix/build/server/hono/server/pdf-child.js'),
  ];

  if (env('NODE_ENV') === 'production') {
    const built = builtCandidates.find((candidate) => existsSync(candidate));

    return built ? { modulePath: built, args: [], execArgv } : null;
  }

  for (const appDir of [cwd, path.join(cwd, 'apps/remix'), path.join(cwd, '../../apps/remix')]) {
    const entry = path.join(appDir, 'server/pdf-child.ts');
    const config = path.join(appDir, 'server/pdf-child.vite.config.mjs');
    const viteNode = path.join(appDir, '../../node_modules/vite-node/vite-node.mjs');

    if (existsSync(entry) && existsSync(config) && existsSync(viteNode)) {
      return { modulePath: viteNode, args: ['--config', config, entry], execArgv };
    }
  }

  return null;
};

type TChildReply = { ready?: true; ok?: boolean; result?: TPdfOperationResult; error?: unknown };

export const runInChild = async (
  operation: TPdfOperation,
  command: TPdfChildCommand,
  timeoutMs = readPositive(env('NEXT_PRIVATE_ST_PDF_CHILD_TIMEOUT_MS'), DEFAULT_PDF_CHILD_TIMEOUT_MS),
): Promise<TPdfOperationResult> => {
  const stats = getPdfChildStats();
  const startedAt = Date.now();

  return await new Promise<TPdfOperationResult>((resolve, reject) => {
    const child = fork(command.modulePath, command.args, {
      execArgv: command.execArgv,
      // Only what the PDF work needs (child-env.ts); the signing certificate settings among it.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      env: buildPdfChildEnv() as NodeJS.ProcessEnv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    liveChildren().add(child);
    child.once('exit', () => liveChildren().delete(child));

    let isSettled = false;
    let isReady = false;

    const settle = (outcome: () => void) => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      clearTimeout(timer);
      outcome();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(createDocumentTooComplexError(`no result within ${Math.round(timeoutMs / 1000)} s`)));
    }, timeoutMs);

    child.on('message', (reply: TChildReply) => {
      if (reply.ready) {
        isReady = true;
        stats.lastStartupMs = Date.now() - startedAt;
        child.send({ operation });

        return;
      }

      if (reply.ok && reply.result) {
        const { result } = reply;
        settle(() => resolve(result));

        return;
      }

      settle(() => reject(AppError.parseFromJSON(reply.error) ?? AppError.parseError(reply.error)));
    });

    child.on('error', (error) => settle(() => reject(error)));

    child.on('exit', (code, signal) => {
      // Ended before it was ready: it could not start (the caller falls back to this process).
      if (!isReady) {
        settle(() => reject(new Error(`The PDF child did not start (code ${code}, signal ${signal})`)));

        return;
      }

      settle(() =>
        reject(
          createDocumentTooComplexError(
            signal ? `the PDF process was stopped (${signal})` : `the PDF process ended with code ${code}`,
          ),
        ),
      );
    });
  });
};

/**
 * Run `operation` in a child when one can be started, else in this process. The input bytes are
 * written to a temp file; the output bytes are read back from one.
 */
export const runPdfOperationIsolated = async <T extends TPdfOperation['kind']>(
  kind: T,
  input: Buffer | Uint8Array,
  options: Omit<Extract<TPdfOperation, { kind: T }>, 'kind' | 'inputPath' | 'outputPath'>,
  {
    command = resolvePdfChildCommand(),
    extraFiles = new Map(),
  }: {
    command?: TPdfChildCommand | null;
    /** More input files, written next to the input (for example a seal's certificate pages). */
    extraFiles?: ReadonlyMap<string, Uint8Array>;
  } = {},
): Promise<TPdfOperationResult & { pdf: Buffer }> => {
  const stats = getPdfChildStats();

  // Solid Ten: a temp folder that is full, read-only or missing: say so once, plainly, and do the
  // work in memory in this process (no files, no child), never hang.
  const runInMemory = async (error: unknown) => {
    stats.tempFolderFailures++;
    fallBackToAppProcess(
      stats,
      `Cannot write PDF temp files in ${getPdfTempRoot()} (${String((error as { code?: unknown }).code)}); ` +
        'free space there or set NEXT_PRIVATE_ST_PDF_TEMP_DIR to a writable folder',
    );

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return await runPdfBytesOperation(
      { ...options, kind } as Parameters<typeof runPdfBytesOperation>[0],
      Buffer.from(input),
      extraFiles,
    );
  };

  let dir: string;

  try {
    dir = await createPdfTempDir();
  } catch (error) {
    if (isTempFolderError(error)) {
      return await runInMemory(error);
    }

    throw error;
  }

  const inputPath = path.join(dir, 'input.pdf');
  const outputPath = path.join(dir, 'output.pdf');

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const operation = { ...options, kind, inputPath, outputPath } as TPdfOperation;

  try {
    try {
      await writePrivateFile(inputPath, input);

      for (const [name, bytes] of extraFiles) {
        await writePrivateFile(path.join(dir, name), bytes);
      }
    } catch (error) {
      if (isTempFolderError(error)) {
        return await runInMemory(error);
      }

      throw error;
    }

    const isDisabled = env('NEXT_PRIVATE_ST_PDF_CHILD_DISABLED') === 'true';
    let result: TPdfOperationResult;

    if (isDisabled || !command) {
      if (!isDisabled) {
        fallBackToAppProcess(stats, 'No PDF child entry found');
      }

      result = await runPdfOperation(operation);
    } else {
      try {
        stats.runs++;
        result = await runInChild(operation, command);
      } catch (error) {
        // The child could not write its output (the folder filled up meanwhile).
        if (isTempFolderError(error)) {
          return await runInMemory(error);
        }

        if (error instanceof AppError) {
          if (error.code === 'DOCUMENT_TOO_COMPLEX') {
            stats.failures++;
          }

          throw error;
        }

        // The child could not start: run here (or refuse, when the child is required).
        fallBackToAppProcess(stats, 'The PDF child could not start', error);
        result = await runPdfOperation(operation);
      }
    }

    return { ...result, pdf: await readFile(outputPath) };
  } finally {
    // Also after a failure, a timeout or a dead child.
    await removePdfTempDir(dir);
  }
};
