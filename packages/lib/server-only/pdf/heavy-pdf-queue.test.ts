import { describe, expect, it } from 'vitest';

import { createHeavyWorkQueue, HEAVY_PDF_BYTES, runHeavyPdfWork } from './heavy-pdf-queue';

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

describe('heavy PDF work queue (LD2-A)', () => {
  it('runs heavy work one at a time, in order', async () => {
    const queue = createHeavyWorkQueue();
    const events: string[] = [];

    const job = (name: string) => async () => {
      events.push(`${name}:start`);
      await sleep(20);
      events.push(`${name}:end`);
      return name;
    };

    await expect(Promise.all([queue.run(job('a')), queue.run(job('b')), queue.run(job('c'))])).resolves.toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('is re-entrant: heavy work inside a held slot runs at once', async () => {
    const queue = createHeavyWorkQueue();

    await expect(queue.run(async () => await queue.run(async () => 'inner'))).resolves.toBe('inner');
    expect(queue.stats()).toEqual({ isBusy: false, waiting: 0 });
  });

  it('refuses with SERVER_BUSY (503, Retry-After) when the wait list is full', async () => {
    const queue = createHeavyWorkQueue({ maxWaiting: 1 });
    const first = queue.run(async () => await sleep(50));
    const second = queue.run(async () => 'second');

    await expect(queue.run(async () => 'third')).rejects.toMatchObject({
      code: 'SERVER_BUSY',
      statusCode: 503,
      headers: { 'Retry-After': expect.any(String) },
    });

    await first;
    await expect(second).resolves.toBe('second');
  });

  it('gives up on a wait that is too long, and keeps serving the others', async () => {
    const queue = createHeavyWorkQueue({ maxWaitMs: 20 });
    const first = queue.run(async () => await sleep(80));

    await expect(queue.run(async () => 'late')).rejects.toMatchObject({ code: 'SERVER_BUSY' });
    await first;
    await expect(queue.run(async () => 'after')).resolves.toBe('after');
  });

  it('releases the slot when work throws', async () => {
    const queue = createHeavyWorkQueue();

    await expect(queue.run(async () => Promise.reject(new Error('broken')))).rejects.toThrow('broken');
    await expect(queue.run(async () => 'next')).resolves.toBe('next');
  });

  it('lets small documents bypass the queue', async () => {
    await expect(runHeavyPdfWork(HEAVY_PDF_BYTES - 1, async () => 'small')).resolves.toBe('small');
  });

  it('lets a background job wait for its turn instead of refusing it', async () => {
    const queue = createHeavyWorkQueue({ maxWaiting: 0, maxWaitMs: 10 });
    const first = queue.run(async () => await sleep(40));

    await expect(queue.run(async () => 'job', { waitForTurn: true })).resolves.toBe('job');
    await first;
  });
});

describe('one heavy PDF queue per process (RT4-L1)', () => {
  it('every copy of the module shares the same queue', async () => {
    const { vi } = await import('vitest');
    const first = await import('./heavy-pdf-queue');

    // A second, separate copy of the module, as the production server has (two bundles).
    vi.resetModules();
    const second = await import('./heavy-pdf-queue');

    expect(second).not.toBe(first);
    expect(second.heavyPdfQueue).toBe(first.heavyPdfQueue);

    let release: () => void = () => {};
    const held = first.heavyPdfQueue.run(async () => await new Promise<void>((resolve) => (release = resolve)));

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(second.heavyPdfQueue.stats().isBusy).toBe(true);

    release();
    await held;
  });
});
