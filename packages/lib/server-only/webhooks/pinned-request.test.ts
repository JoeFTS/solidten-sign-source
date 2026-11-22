import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { postPinned } from './pinned-request';

const servers: http.Server[] = [];

const listen = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('postPinned (retest: a dripping receiver holds a job slot)', () => {
  it('gives up at the deadline even when the receiver keeps sending a byte at a time', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });

      // One byte every 100 ms, forever: never idle long enough for an idle timeout.
      const drip = setInterval(() => response.write('.'), 100);
      response.on('close', () => clearInterval(drip));
    });

    const started = Date.now();

    await expect(
      postPinned({ url, body: '{}', headers: {}, pinned: { address: '127.0.0.1', family: 4 }, timeoutMs: 800 }),
    ).rejects.toThrow('timed out');

    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it('stops reading at the size cap and answers with what it has', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });

      // Far more than the 256 KB cap, sent slowly enough that the deadline is not what ends it.
      const chunk = 'x'.repeat(64 * 1024);
      const pump = setInterval(() => response.write(chunk), 5);
      response.on('close', () => clearInterval(pump));
    });

    const result = await postPinned({
      url,
      body: '{}',
      headers: {},
      pinned: { address: '127.0.0.1', family: 4 },
      timeoutMs: 5_000,
    });

    expect(result.status).toBe(200);
    expect(result.text.length).toBeLessThanOrEqual(256 * 1024);
  }, 10_000);

  it('still returns a normal response', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    const result = await postPinned({
      url,
      body: '{}',
      headers: {},
      pinned: { address: '127.0.0.1', family: 4 },
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({ status: 201, ok: true, text: '{"ok":true}' });
  });
});
