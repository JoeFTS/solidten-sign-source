import { describe, expect, it } from 'vitest';

import { canPresignTokenReachEnvelope } from './presign-envelope-scope';

const document = { id: 'envelope_abc', secondaryId: 'document_12', teamId: 4 };
const template = { id: 'envelope_def', secondaryId: 'template_7', teamId: 4 };

describe('canPresignTokenReachEnvelope', () => {
  it('refuses an envelope of another team, scoped or not', () => {
    expect(canPresignTokenReachEnvelope({ teamId: 3 }, document)).toBe(false);
    expect(canPresignTokenReachEnvelope({ teamId: 3, scope: 'envelopeId:envelope_abc' }, document)).toBe(false);
  });

  it('lets an unscoped token reach any envelope of its team', () => {
    expect(canPresignTokenReachEnvelope({ teamId: 4 }, document)).toBe(true);
  });

  it('lets a scoped token reach only the envelope it names, in each scope form', () => {
    expect(canPresignTokenReachEnvelope({ teamId: 4, scope: 'envelopeId:envelope_abc' }, document)).toBe(true);
    expect(canPresignTokenReachEnvelope({ teamId: 4, scope: 'documentId:12' }, document)).toBe(true);
    expect(canPresignTokenReachEnvelope({ teamId: 4, scope: 'templateId:7' }, template)).toBe(true);

    expect(canPresignTokenReachEnvelope({ teamId: 4, scope: 'envelopeId:envelope_def' }, document)).toBe(false);
    expect(canPresignTokenReachEnvelope({ teamId: 4, scope: 'documentId:13' }, document)).toBe(false);
    expect(canPresignTokenReachEnvelope({ teamId: 4, scope: 'templateId:12' }, document)).toBe(false);
    expect(canPresignTokenReachEnvelope({ teamId: 4, scope: 'documentId:7' }, template)).toBe(false);
  });
});
