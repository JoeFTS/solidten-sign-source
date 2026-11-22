type TDeliveryLog = { createdAt: Date };

type TDeliveryLogs = {
  emailed: TDeliveryLog | null;
  texted?: TDeliveryLog | null;
};

/**
 * The earliest moment the signing link reached the recipient by any channel.
 */
export const getFirstSigningLinkDelivery = (logs: TDeliveryLogs): TDeliveryLog | null => {
  const candidates = [logs.emailed, logs.texted].filter((log): log is TDeliveryLog => Boolean(log));

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((earliest, log) => (log.createdAt < earliest.createdAt ? log : earliest));
};

/**
 * Null when the link was not texted, so certificates for email-only envelopes stay unchanged.
 */
export const getSigningLinkChannel = (logs: TDeliveryLogs): 'SMS' | 'EMAIL_AND_SMS' | null => {
  if (!logs.texted) {
    return null;
  }

  return logs.emailed ? 'EMAIL_AND_SMS' : 'SMS';
};
