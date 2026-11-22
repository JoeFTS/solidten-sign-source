import { timingSafeEqual } from 'node:crypto';

import { env } from '../../utils/env';

/**
 * Solid Ten Sign: /api/health is public, but its detail (job counts, caps reached today,
 * the PDF queue) tells an outsider when the service is degraded or a cap is spent.
 *
 * Detail is served when the request carries `Authorization: Bearer <NEXT_PRIVATE_ST_HEALTH_TOKEN>`.
 * When that variable is unset, only to direct local calls: requests without an
 * X-Forwarded-For header (the proxy always sets it for outside requests).
 */
export const canSeeHealthDetail = (
  headers: Headers,
  configuredToken: string | undefined = env('NEXT_PRIVATE_ST_HEALTH_TOKEN'),
) => {
  const token = configuredToken?.trim();

  if (token) {
    const presented =
      headers
        .get('authorization')
        ?.match(/^Bearer\s+(.+)$/i)?.[1]
        ?.trim() ?? '';
    const expected = Buffer.from(token);
    const given = Buffer.from(presented);

    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  return !headers.has('x-forwarded-for');
};
