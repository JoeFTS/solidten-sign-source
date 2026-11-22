import { describe, expect, it } from 'vitest';

import {
  collectTurnTokenFields,
  createInPersonTurnToken,
  isInPersonTurnToken,
  replaceTurnTokenFields,
} from './in-person-turn-token';

const credential = createInPersonTurnToken();
const realToken = 'real-link-token-0123456789';
const exchanged = new Map([[credential, realToken]]);

describe('in-person turn credential swap (SEC2-M1)', () => {
  it('swaps the exact value of a token key, at any depth', () => {
    const input = { json: { token: credential, fieldId: 1 } };

    expect(collectTurnTokenFields(input)).toEqual(new Set([credential]));
    expect(replaceTurnTokenFields(input, exchanged)).toEqual({ json: { token: realToken, fieldId: 1 } });
  });

  it('never swaps a credential inside a comment body', () => {
    const input = { json: { token: credential, body: `my code is ${credential}` } };

    expect(replaceTurnTokenFields(input, exchanged)).toEqual({
      json: { token: realToken, body: `my code is ${credential}` },
    });
  });

  it('never swaps a credential that is the whole value of a non-token key', () => {
    const input = { json: { token: credential, body: credential, name: credential } };

    expect(replaceTurnTokenFields(input, exchanged).json).toEqual({
      token: realToken,
      body: credential,
      name: credential,
    });
  });

  it('never swaps a credential in a text field value', () => {
    const input = { json: { token: credential, fieldId: 7, fieldValue: { type: 'TEXT', value: credential } } };

    expect(replaceTurnTokenFields(input, exchanged).json.fieldValue.value).toBe(credential);
  });

  it('never swaps a credential in a reassignment name or reason', () => {
    const input = {
      json: { token: credential, name: `Pat ${credential}`, email: 'pat@example.com', reason: credential },
    };

    expect(replaceTurnTokenFields(input, exchanged).json).toEqual({
      token: realToken,
      name: `Pat ${credential}`,
      email: 'pat@example.com',
      reason: credential,
    });
  });

  it('does not collect a credential that is only part of a token value', () => {
    expect(collectTurnTokenFields({ token: `x${credential}` }).size).toBe(0);
    expect(collectTurnTokenFields({ token: `${credential} ` }).size).toBe(0);
    expect(collectTurnTokenFields({ body: credential }).size).toBe(0);
  });

  it('handles token keys in FormData and arrays of objects', () => {
    const form = new FormData();
    form.append('token', credential);
    form.append('note', credential);

    const swapped = replaceTurnTokenFields(form, exchanged);

    expect(swapped.get('token')).toBe(realToken);
    expect(swapped.get('note')).toBe(credential);

    expect(replaceTurnTokenFields([{ token: credential }, credential], exchanged)).toEqual([
      { token: realToken },
      credential,
    ]);
  });

  it('recognises only a whole, well-formed credential', () => {
    expect(isInPersonTurnToken(credential)).toBe(true);
    expect(isInPersonTurnToken(`${credential}a`)).toBe(false);
    expect(isInPersonTurnToken('ipt_short')).toBe(false);
  });
});
