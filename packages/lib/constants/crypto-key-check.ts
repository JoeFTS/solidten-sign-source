/** The sample keys in `.env.example` and the Dockerfile build arguments. */
const SAMPLE_ENCRYPTION_KEYS = ['CAFEBABE', 'DEADBEEF'];

/**
 * Solid Ten: why the two encryption keys cannot protect stored secrets (2FA secrets, signing
 * credentials), or `null` when they can. A missing key, a sample key from the repository, or two
 * equal keys make the stored secrets readable to anyone with the source.
 */
export const getEncryptionKeyProblem = (primary: string | undefined, secondary: string | undefined) => {
  if (!primary || !secondary) {
    return 'NEXT_PRIVATE_ENCRYPTION_KEY and NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY must both be set';
  }

  if (SAMPLE_ENCRYPTION_KEYS.includes(primary) || SAMPLE_ENCRYPTION_KEYS.includes(secondary)) {
    return 'An encryption key still has the sample value from the repository; set your own random keys';
  }

  if (primary === secondary) {
    return 'NEXT_PRIVATE_ENCRYPTION_KEY and NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY cannot be equal';
  }

  return null;
};
