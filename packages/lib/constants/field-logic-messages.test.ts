import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { beforeAll, describe, expect, it } from 'vitest';

import { FIELD_LOGIC_FORMULA_HINT, FIELD_LOGIC_FORMULA_PLACEHOLDER } from './field-logic-messages';

describe('field logic messages', () => {
  beforeAll(() => {
    // No compiled catalog: the source text is formatted at run time, as for a string not yet translated.
    i18n.loadAndActivate({ locale: 'en', messages: {} });
  });

  it('shows the curly-bracket examples as written', () => {
    expect(i18n._(FIELD_LOGIC_FORMULA_PLACEHOLDER)).toBe('For example: {{price}} * {{quantity}}');
    expect(i18n._(FIELD_LOGIC_FORMULA_HINT)).toContain('for example {{price}}.');
    expect(i18n._(FIELD_LOGIC_FORMULA_HINT)).toContain('ROUND(value, digits)');
  });

  it('would lose the brackets if they were written inside the message (the old defect)', () => {
    expect(i18n._(msg`For example: {{price}} * {{quantity}}`)).not.toContain('{{price}}');
  });
});
