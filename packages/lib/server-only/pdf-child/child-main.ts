import { writeFileSync } from 'node:fs';

import { AppError } from '../../errors/app-error';
import { runPdfOperation, type TPdfOperation } from './pdf-operations';

/**
 * Solid Ten: the PDF child process. It receives one operation over IPC, runs it, sends the
 * result and exits, so all memory it used goes back to the system.
 */
type TChildRequest = { operation: TPdfOperation };

const raiseOomScore = () => {
  // Linux: if the container's memory fills, the kernel kills this child, not the app.
  try {
    writeFileSync('/proc/self/oom_score_adj', '1000');
  } catch {
    // Not Linux, or not allowed: the heap ceiling still applies.
  }
};

/**
 * Returns a promise that settles only when the process exits: the dev runner (vite-node) keeps
 * its module loader open while the entry awaits it, and the operations load modules on demand.
 */
export const startPdfChild = async () => {
  raiseOomScore();

  // This process is the PDF child: its work never goes to another child. It runs PDF operations
  // only, with no database (SEC3-M1).
  globalThis.__solidten_in_pdf_child__ = true;

  process.once('message', (message: TChildRequest) => {
    void (async () => {
      try {
        const result = await runPdfOperation(message.operation);

        process.send?.({ ok: true, result });
      } catch (error) {
        const appError = AppError.parseError(error);

        process.send?.({ ok: false, error: AppError.toJSON(appError) });
      } finally {
        // Let the reply flush, then leave.
        setTimeout(() => process.exit(0), 20);
      }
    })();
  });

  process.send?.({ ready: true });

  await new Promise<never>(() => {
    // Settled by process.exit after the reply.
  });
};
