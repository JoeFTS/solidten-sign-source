export type PresignEnvelopeClaims = {
  /** The team of the API token that signed the presign token. */
  teamId: number;
  /** The `scope` claim of the presign token, if it has one. */
  scope?: string;
};

export type PresignEnvelopeTarget = {
  id: string;
  secondaryId: string;
  teamId: number;
};

/**
 * Solid Ten (AUD-21): a presign token reaches only envelopes of its own API token's team, and a scoped
 * token only the one envelope it names. The embed pages scope by `envelopeId:<id>` (v2) or by the
 * legacy `documentId:<n>` / `templateId:<n>` (v1), so each form is matched against the envelope.
 */
export const canPresignTokenReachEnvelope = (claims: PresignEnvelopeClaims, envelope: PresignEnvelopeTarget) => {
  if (claims.teamId !== envelope.teamId) {
    return false;
  }

  if (!claims.scope) {
    return true;
  }

  const allowedScopes = [`envelopeId:${envelope.id}`];

  const [prefix, legacyId, ...rest] = envelope.secondaryId.split('_');

  if (legacyId && rest.length === 0 && /^\d+$/.test(legacyId)) {
    if (prefix === 'document') {
      allowedScopes.push(`documentId:${legacyId}`);
    }

    if (prefix === 'template') {
      allowedScopes.push(`templateId:${legacyId}`);
    }
  }

  return allowedScopes.includes(claims.scope);
};
