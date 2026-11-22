import { createRateLimit } from '../rate-limit/rate-limit';

// Keyed by IP and in-person session. A real handover needs a handful of calls.
export const inPersonSignerActionRateLimit = createRateLimit({
  action: 'in-person.signer-action',
  max: 30,
  globalMax: 120,
  window: '15m',
});

// Email codes sent to a signer during a handover.
export const inPersonEmailCodeRateLimit = createRateLimit({
  action: 'in-person.email-code',
  max: 5,
  globalMax: 30,
  window: '15m',
});

// Wrong PINs end the session (see IN_PERSON_MAX_PIN_ATTEMPTS); this caps the IP as well.
export const inPersonPinRateLimit = createRateLimit({
  action: 'in-person.pin',
  max: 20,
  globalMax: 60,
  window: '15m',
});
