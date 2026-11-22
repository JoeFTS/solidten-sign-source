import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

export type TPinnedResponse = {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
};

const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Solid Ten Sign (S-L4): POST to a webhook URL, connecting only to `pinned` (the address
 * that was checked), never to whatever a second DNS lookup returns. TLS still checks the
 * certificate against the URL's hostname. Redirects are not followed. With `pinned` null
 * (a bypass-list host) the system resolver is used.
 */
export const postPinned = async ({
  url,
  body,
  headers,
  pinned,
  timeoutMs,
}: {
  url: string;
  body: string;
  headers: Record<string, string>;
  pinned: { address: string; family: 4 | 6 } | null;
  timeoutMs: number;
}): Promise<TPinnedResponse> => {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;

  const lookup: LookupFunction | undefined = pinned
    ? (_hostname, options, callback) => {
        if (typeof options === 'object' && options?.all) {
          // biome-ignore lint/suspicious/noExplicitAny: node's overloaded callback type.
          (callback as any)(null, [{ address: pinned.address, family: pinned.family }]);

          return;
        }

        callback(null, pinned.address, pinned.family);
      }
    : undefined;

  return await new Promise<TPinnedResponse>((resolvePromise, rejectPromise) => {
    // Solid Ten Sign (retest): `timeout` below is an idle timeout, reset by every byte. A receiver
    // that drips its response held the call (and a job slot) for as long as it liked. The whole
    // call now has one deadline, and reading stops at MAX_RESPONSE_BYTES.
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(deadline);
      callback();
    };

    const resolve = (value: TPinnedResponse) => finish(() => resolvePromise(value));
    const reject = (error: unknown) => finish(() => rejectPromise(error));

    const deadline = setTimeout(() => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const request = client.request(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
        lookup,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;

        const done = () => {
          const status = response.statusCode ?? 0;

          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(', ') : (value ?? ''),
              ]),
            ),
            text: Buffer.concat(chunks).toString('utf8'),
          });
        };

        response.on('data', (chunk: Buffer) => {
          size += chunk.length;

          if (size <= MAX_RESPONSE_BYTES) {
            chunks.push(chunk);

            return;
          }

          // Enough of the body for the log: answer now and drop the connection.
          done();
          response.destroy();
        });

        response.on('end', done);

        response.on('error', reject);
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    request.on('error', reject);

    request.end(body);
  });
};
