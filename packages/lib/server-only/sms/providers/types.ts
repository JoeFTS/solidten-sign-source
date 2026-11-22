export type TSmsSendInput = {
  toE164: string;
  body: string;
};

export type TSmsSendResult =
  | { success: true; providerMessageId: string | null }
  | {
      success: false;
      reason: 'OPTED_OUT' | 'INVALID_NUMBER' | 'PROVIDER_ERROR' | 'TIMEOUT';
      errorCode: string | null;
      message: string;
      /** True when the same text could succeed later (5xx, 429, timeout). */
      isRetryable: boolean;
    };

export type TSmsProvider = {
  name: 'twilio' | 'fake';
  send: (input: TSmsSendInput) => Promise<TSmsSendResult>;
};
