import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';
import { SIGNIN_LINK_RETRY_JOB_ID } from '../../client/job-retry-policy';

const ZSendSigninLinkRetryPayloadSchema = z.object({
  email: z.string(),
});

export type TSendSigninLinkRetryJobDefinition = z.infer<typeof ZSendSigninLinkRetryPayloadSchema>;

/**
 * Solid Ten: a sign-in link email that failed when it was asked for is tried again
 * (1, 5 and 15 minutes later, see job-retry-policy.ts). Each attempt mails a fresh link; the
 * token itself never goes into the job row.
 */
export const SEND_SIGNIN_LINK_RETRY_JOB_DEFINITION = {
  id: SIGNIN_LINK_RETRY_JOB_ID,
  name: 'Retry Sign-in Link Email',
  version: '1.0.0',
  trigger: {
    name: SIGNIN_LINK_RETRY_JOB_ID,
    schema: ZSendSigninLinkRetryPayloadSchema,
  },
  handler: async ({ payload }) => {
    const { isSigninDisabledGlobally } = await import('../../../constants/auth');
    const { sendEmailLinkSignin } = await import('../../../server-only/auth/send-email-link-signin');

    // Sign-in was turned off since the request: send nothing.
    if (isSigninDisabledGlobally()) {
      return;
    }

    await sendEmailLinkSignin({ email: payload.email });
  },
} as const satisfies JobDefinition<typeof SIGNIN_LINK_RETRY_JOB_ID, TSendSigninLinkRetryJobDefinition>;
