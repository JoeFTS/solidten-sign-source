// Test child for run-pdf-operation.test.ts. The first argument picks the behaviour.
import { copyFileSync } from 'node:fs';

const mode = process.argv[2];

if (mode === 'no-start') {
  process.exit(3);
}

process.once('message', ({ operation }) => {
  if (mode === 'crash') {
    process.kill(process.pid, 'SIGKILL');
  }

  if (mode === 'hang') {
    return;
  }

  if (mode === 'enospc') {
    process.send({ ok: false, error: { code: 'ENOSPC', message: 'ENOSPC: no space left on device, write' } });
    setTimeout(() => process.exit(0), 20);
    return;
  }

  if (mode === 'app-error') {
    process.send({
      ok: false,
      error: { code: 'INVALID_DOCUMENT_FILE', message: 'The document is password protected' },
    });
    setTimeout(() => process.exit(0), 20);
    return;
  }

  copyFileSync(operation.inputPath, operation.outputPath);
  process.send({ ok: true, result: { pageCount: 7, pid: process.pid } });
  setTimeout(() => process.exit(0), 20);
});

process.send({ ready: true });
