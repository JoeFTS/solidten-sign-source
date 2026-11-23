import type { Field } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { isRequiredField } from '../utils/advanced-fields-helpers';
import { FIELD_VALUE_MATRIX } from './__fixtures__/field-value-matrix';
import { checkFieldValue, type TValueRepresentation } from './field-value-rules';

const representations: TValueRepresentation[] = ['option-value', 'option-index'];

describe('the value rules every route uses (L round 2)', () => {
  for (const representation of representations) {
    describe(representation, () => {
      for (const row of FIELD_VALUE_MATRIX) {
        const value = row.values[representation];

        if (value === undefined) {
          continue;
        }

        it(`${row.name}: ${row.expect}`, () => {
          const field = { type: row.type, fieldMeta: row.meta };

          const check = checkFieldValue({
            field,
            value,
            representation,
            isRequired: isRequiredField(field as Field),
            isBase64: false,
            typedSignatureEnabled: row.typedSignatureEnabled ?? true,
          });

          expect(check.result).toBe(row.expect);
        });
      }
    });
  }

  it('a field hidden by field logic is not required: empty is allowed', () => {
    expect(
      checkFieldValue({
        field: { type: 'TEXT', fieldMeta: { type: 'text', required: true } },
        value: '',
        representation: 'option-index',
        isRequired: false,
      }).result,
    ).toBe('empty');
  });

  it('a drawn signature is allowed when typed signatures are off', () => {
    expect(
      checkFieldValue({
        field: { type: 'SIGNATURE', fieldMeta: { type: 'signature' } },
        value: 'data:image/png;base64,iVBORw0KGgo=',
        representation: 'option-index',
        isRequired: true,
        isBase64: true,
        typedSignatureEnabled: false,
      }).result,
    ).toBe('ok');
  });

  it('a version-1 option without text is sent as empty-value-<id>', () => {
    expect(
      checkFieldValue({
        field: {
          type: 'RADIO',
          fieldMeta: { type: 'radio', values: [{ id: 7, checked: false, value: '' }] },
        },
        value: 'empty-value-7',
        representation: 'option-value',
        isRequired: false,
      }).result,
    ).toBe('ok');
  });
});
