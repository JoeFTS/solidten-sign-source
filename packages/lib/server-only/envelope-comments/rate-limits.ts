import { createRateLimit } from '../rate-limit/rate-limit';

// Keyed by IP and the signer's link token. A real signer asks a few questions;
// this stops a flood without getting in their way.
export const recipientCommentRateLimit = createRateLimit({
  action: 'comment.recipient-post',
  max: 5,
  globalMax: 20,
  window: '10m',
});

// Keyed by IP and user.
export const teamCommentRateLimit = createRateLimit({
  action: 'comment.team-post',
  max: 30,
  globalMax: 60,
  window: '10m',
});
