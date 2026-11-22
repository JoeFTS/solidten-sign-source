import { env } from '../utils/env';
import { getEncryptionKeyProblem } from './crypto-key-check';

export const DOCUMENSO_ENCRYPTION_KEY = env('NEXT_PRIVATE_ENCRYPTION_KEY');

export const DOCUMENSO_ENCRYPTION_SECONDARY_KEY = env('NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY');

// Solid Ten: refuse to start a production server whose keys cannot protect stored secrets. Dev and
// test set-ups keep the sample keys from .env.example.
if (typeof window === 'undefined' && process.env.NODE_ENV === 'production') {
  const problem = getEncryptionKeyProblem(DOCUMENSO_ENCRYPTION_KEY, DOCUMENSO_ENCRYPTION_SECONDARY_KEY);

  if (problem) {
    throw new Error(`Solid Ten Sign will not start: ${problem}.`);
  }
}
