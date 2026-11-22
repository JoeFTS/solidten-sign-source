import { createRateLimit } from '../rate-limit/rate-limit';

// Keyed by IP and by the recipient of the signing link. A signer attaches a few files
// and may replace some; the headroom covers retries after a refused file.
export const fieldFileUploadRateLimit = createRateLimit({
  action: 'field-file.upload',
  max: 20,
  globalMax: 60,
  window: '1h',
});

export const fieldFileRemoveRateLimit = createRateLimit({
  action: 'field-file.remove',
  max: 30,
  globalMax: 90,
  window: '1h',
});

// Downloads by signing link: a signer checks their own files, so the limit is generous.
export const fieldFileDownloadRateLimit = createRateLimit({
  action: 'field-file.download',
  max: 120,
  globalMax: 300,
  window: '1h',
});
