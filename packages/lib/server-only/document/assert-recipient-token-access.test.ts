import { describe, expect, it } from 'vitest';

import { readRecipientTokensFromInput } from './assert-recipient-token-access';

describe('readRecipientTokensFromInput (SEC3-C1, AUD-6)', () => {
  it('finds the token in plain, superjson and nested access inputs', () => {
    expect(readRecipientTokensFromInput({ token: 'abc', fieldId: 1 })).toEqual(['abc']);
    expect(readRecipientTokensFromInput({ json: { token: 'abc' } })).toEqual(['abc']);
    expect(readRecipientTokensFromInput({ recipientToken: 'abc' })).toEqual(['abc']);
    expect(readRecipientTokensFromInput({ envelopeId: 'e', access: { type: 'recipient', token: 'abc' } })).toEqual([
      'abc',
    ]);
  });

  it('finds the token in a FormData upload payload', () => {
    const form = new FormData();
    form.append('payload', JSON.stringify({ token: 'abc', fieldId: 1 }));

    expect(readRecipientTokensFromInput(form)).toEqual(['abc']);
  });

  it('finds the token in a JSON payload object, as in a FormData upload (AUD-C11 note)', () => {
    expect(readRecipientTokensFromInput({ payload: { token: 'tok_json_payload' } })).toEqual(['tok_json_payload']);
    expect(readRecipientTokensFromInput({ json: { payload: { token: 'tok_superjson_payload' } } })).toEqual([
      'tok_superjson_payload',
    ]);
  });

  it('finds nothing when there is no token', () => {
    expect(readRecipientTokensFromInput(undefined)).toEqual([]);
    expect(readRecipientTokensFromInput({ envelopeId: 'e', access: { type: 'user' } })).toEqual([]);
    expect(readRecipientTokensFromInput({ token: '' })).toEqual([]);

    const form = new FormData();
    form.append('payload', 'not json');
    expect(readRecipientTokensFromInput(form)).toEqual([]);
  });

  it('returns a decoy and the real token, so a decoy cannot hide the real one (AUD-6)', () => {
    const form = new FormData();
    form.append('token', 'decoy');
    form.append('payload', JSON.stringify({ token: 'real', fieldId: 1 }));

    expect(readRecipientTokensFromInput(form).sort()).toEqual(['decoy', 'real']);

    expect(
      readRecipientTokensFromInput({ token: 'decoy', envelopeId: 'e', access: { type: 'recipient', token: 'real' } }),
    ).toEqual(['decoy', 'real']);
    expect(readRecipientTokensFromInput({ token: 'decoy', recipientToken: 'real' })).toEqual(['decoy', 'real']);
  });

  it('never reads a two-factor code as a link token', () => {
    expect(
      readRecipientTokensFromInput({
        token: 'link',
        fieldId: 1,
        authOptions: { type: 'TWO_FACTOR_AUTH', token: '123456' },
      }),
    ).toEqual(['link']);
    expect(
      readRecipientTokensFromInput({
        json: { token: 'link', accessAuthOptions: { type: 'TWO_FACTOR_AUTH', token: '123456', method: 'email' } },
      }),
    ).toEqual(['link']);
  });
});
