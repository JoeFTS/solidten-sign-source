import { createRateLimit } from '../rate-limit/rate-limit';

// Identifier is the form id (per link), so one busy form cannot use up another form's budget.
// The IP limit (globalMax) is across all forms.
export const publicFormOpenRateLimit = createRateLimit({
  action: 'st.form.open',
  max: 1000,
  globalMax: 60,
  window: '10m',
});

// Ten submissions an hour from one IP leaves room for an office behind one address.
export const publicFormSubmitRateLimit = createRateLimit({
  action: 'st.form.submit',
  max: 200,
  globalMax: 10,
  window: '1h',
});

// Identifier is the form id plus a hash of the email address, never the address itself.
export const publicFormCodeRequestRateLimit = createRateLimit({
  action: 'st.form.code-request',
  max: 3,
  globalMax: 10,
  window: '15m',
});

export const publicFormCodeVerifyRateLimit = createRateLimit({
  action: 'st.form.code-verify',
  max: 30,
  globalMax: 30,
  window: '15m',
});
