import { decodeJwt } from 'jose';
import {
  canPresignTokenReachEnvelope,
  type PresignEnvelopeClaims,
  type PresignEnvelopeTarget,
} from './presign-envelope-scope';
import { verifyEmbeddingPresignToken } from './verify-embedding-presign-token';

export type VerifiedPresignFileToken = PresignEnvelopeClaims & { userId: number };

/**
 * Solid Ten (AUD-21): verify a presign token on a file read route and keep its team and scope, so
 * the route can check them against the envelope it serves (`presignFileTokenReachesEnvelope`).
 */
export const verifyPresignFileToken = async (token: string): Promise<VerifiedPresignFileToken | undefined> => {
  const verified = await verifyEmbeddingPresignToken({ token }).catch(() => undefined);

  if (!verified) {
    return undefined;
  }

  const { scope } = decodeJwt(token);

  return {
    userId: verified.userId,
    teamId: verified.teamId,
    scope: typeof scope === 'string' && scope.length > 0 ? scope : undefined,
  };
};

export const presignFileTokenReachesEnvelope = (
  presign: VerifiedPresignFileToken | undefined,
  envelope: PresignEnvelopeTarget,
) => !presign || canPresignTokenReachEnvelope(presign, envelope);
