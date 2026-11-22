import { prisma } from '@documenso/prisma';

import type { TSmsProvider } from './types';

/**
 * Numbers that make the fake provider fail, so tests and local runs can see each failure path.
 * They sit in the 555-0100..0199 range, which is reserved for fiction and never rings a phone.
 */
export const FAKE_SMS_NUMBERS = {
  INVALID: '+12025550101',
  OPTED_OUT: '+12025550102',
  SERVER_ERROR: '+12025550103',
  TIMEOUT: '+12025550104',
} as const;

export const createFakeSmsProvider = (): TSmsProvider => ({
  name: 'fake',
  send: async ({ toE164, body }) => {
    switch (toE164) {
      case FAKE_SMS_NUMBERS.INVALID:
        return {
          success: false,
          reason: 'INVALID_NUMBER',
          errorCode: '21211',
          message: "The 'To' number is not a valid phone number.",
          isRetryable: false,
        };
      case FAKE_SMS_NUMBERS.OPTED_OUT:
        return {
          success: false,
          reason: 'OPTED_OUT',
          errorCode: '21610',
          message: 'Attempt to send to unsubscribed recipient',
          isRetryable: false,
        };
      case FAKE_SMS_NUMBERS.SERVER_ERROR:
        return {
          success: false,
          reason: 'PROVIDER_ERROR',
          errorCode: 'HTTP_503',
          message: 'Service unavailable',
          isRetryable: true,
        };
      case FAKE_SMS_NUMBERS.TIMEOUT:
        return {
          success: false,
          reason: 'TIMEOUT',
          errorCode: 'TIMEOUT',
          message: 'The provider did not answer in time',
          isRetryable: true,
        };
    }

    const message = await prisma.smsFakeOutbox.create({
      data: { toE164, body },
    });

    return { success: true, providerMessageId: `fake_${message.id}` };
  },
});
