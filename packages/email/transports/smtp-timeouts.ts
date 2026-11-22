/**
 * Solid Ten (AUD-25): limits for every SMTP transport. Nodemailer waits up to 2 minutes for a
 * connection and 10 minutes on a silent socket by default; a stalled mail server then held a job
 * slot that long for each email. With these limits a stalled server fails the send in seconds and
 * the job's own retry takes over.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;
