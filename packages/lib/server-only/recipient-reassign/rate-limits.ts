import { createRateLimit } from '../rate-limit/rate-limit';

// Keyed by IP and recipient. A real signer reassigns once; the headroom covers
// typos that the server refuses (an email already on the document, say).
export const recipientReassignRateLimit = createRateLimit({
  action: 'recipient.reassign',
  max: 5,
  globalMax: 30,
  window: '1h',
});
