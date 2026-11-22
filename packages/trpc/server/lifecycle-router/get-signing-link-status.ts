import { getSigningLinkStatus } from '@documenso/lib/server-only/recipient-reassign/get-signing-link-status';
import { z } from 'zod';

import { procedure } from '../trpc';

/**
 * NOTE: PUBLIC. Keyed by the signing link token; says only whether the link
 * still works, was handed to someone else, or its document was cancelled.
 */
export const getSigningLinkStatusRoute = procedure
  .input(z.object({ token: z.string().min(1).max(128) }))
  .output(z.object({ status: z.enum(['ACTIVE', 'REASSIGNED', 'CANCELLED', 'UNKNOWN']) }))
  .query(async ({ input }) => {
    return { status: await getSigningLinkStatus({ token: input.token }) };
  });
