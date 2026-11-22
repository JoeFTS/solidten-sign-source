import { isTspEnvelope } from '../types/signature-level';

export type FieldLogicUnavailableReason = 'VERSION_1' | 'TSP';

/**
 * Whether conditions and formulas can be used on an envelope. The server's save check and
 * the editor's rules panel both ask this, so they cannot drift apart. Templates with a
 * direct link or public form are allowed: their submissions apply the rules on the server.
 *
 * `signatureLevel` may be unknown (the editor does not load it); the server always passes it.
 */
export const getFieldLogicUnavailableReason = (envelope: {
  internalVersion: number;
  signatureLevel?: string | null;
}): FieldLogicUnavailableReason | null => {
  if (envelope.internalVersion !== 2) {
    return 'VERSION_1';
  }

  if (envelope.signatureLevel && isTspEnvelope({ signatureLevel: envelope.signatureLevel })) {
    return 'TSP';
  }

  return null;
};
