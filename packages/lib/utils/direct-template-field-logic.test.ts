import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { applyDirectTemplateFieldLogic } from './direct-template-field-logic';

let nextId = 1;

const makeField = (type: FieldType, fieldMeta: Record<string, unknown>, customText = '') => ({
  id: nextId++,
  type,
  recipientId: 1,
  envelopeItemId: 'item-1',
  customText,
  fieldMeta: { type: type.toLowerCase(), ...fieldMeta },
});

const setup = () => {
  const agree = makeField(FieldType.CHECKBOX, {
    fieldKey: 'agree',
    values: [{ id: 1, checked: false, value: 'Yes' }],
  });
  const details = makeField(FieldType.TEXT, {
    required: true,
    condition: { fieldKey: 'agree', operator: 'checked', value: 'Yes' },
  });
  const price = makeField(FieldType.NUMBER, { fieldKey: 'price' });
  const quantity = makeField(FieldType.NUMBER, { fieldKey: 'quantity' });
  const total = makeField(FieldType.NUMBER, { formula: '{{price}} * {{quantity}}' });
  const signature = makeField(FieldType.SIGNATURE, {});

  return {
    agree,
    details,
    price,
    quantity,
    total,
    signature,
    fields: [agree, details, price, quantity, total, signature],
  };
};

describe('direct template field rules', () => {
  it('keeps a submission without rules unchanged', () => {
    const field = makeField(FieldType.TEXT, {});
    const signedFieldValues = [{ fieldId: field.id, value: 'hello' }];

    const result = applyDirectTemplateFieldLogic({ fields: [field], signedFieldValues, readOnlyValues: new Map() });

    expect(result).toEqual({ success: true, signedFieldValues, notRequiredFieldIds: new Set() });
  });

  it('accepts an honest submission and drops the calculated value for the server to write', () => {
    const { agree, details, price, quantity, total, signature, fields } = setup();

    const result = applyDirectTemplateFieldLogic({
      fields,
      signedFieldValues: [
        { fieldId: agree.id, value: '[0]' },
        { fieldId: details.id, value: 'More text' },
        { fieldId: price.id, value: '2.5' },
        { fieldId: quantity.id, value: '4' },
        { fieldId: total.id, value: '10' },
        { fieldId: signature.id, value: 'Ann', isBase64: false },
      ],
      readOnlyValues: new Map(),
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.signedFieldValues.map((value) => value.fieldId)).not.toContain(total.id);
      expect(result.notRequiredFieldIds.has(total.id)).toBe(true);
      expect(result.notRequiredFieldIds.has(details.id)).toBe(false);
    }
  });

  it('refuses a value for a field its condition hides', () => {
    const { details, fields } = setup();

    const result = applyDirectTemplateFieldLogic({
      fields,
      signedFieldValues: [{ fieldId: details.id, value: 'Sneaked in' }],
      readOnlyValues: new Map(),
    });

    expect(result).toEqual({ success: false, fieldId: details.id, reason: 'HIDDEN_FIELD_HAS_VALUE' });
  });

  it('does not require a hidden required field', () => {
    const { details, fields } = setup();

    const result = applyDirectTemplateFieldLogic({ fields, signedFieldValues: [], readOnlyValues: new Map() });

    expect(result.success && result.notRequiredFieldIds.has(details.id)).toBe(true);
  });

  it('refuses a calculated value the server does not reach', () => {
    const { price, quantity, total, fields } = setup();

    const result = applyDirectTemplateFieldLogic({
      fields,
      signedFieldValues: [
        { fieldId: price.id, value: '2.5' },
        { fieldId: quantity.id, value: '4' },
        { fieldId: total.id, value: '1' },
      ],
      readOnlyValues: new Map(),
    });

    expect(result).toEqual({ success: false, fieldId: total.id, reason: 'CALCULATED_VALUE_CHANGED' });
  });

  it('refuses an empty shown conditional required field', () => {
    const { agree, details, fields } = setup();

    const result = applyDirectTemplateFieldLogic({
      fields,
      signedFieldValues: [
        { fieldId: agree.id, value: '[0]' },
        { fieldId: details.id, value: '' },
      ],
      readOnlyValues: new Map(),
    });

    expect(result).toEqual({ success: false, fieldId: details.id, reason: 'CONDITIONAL_FIELD_EMPTY' });
  });

  it('uses the sender value of a read-only source and refuses a changed one', () => {
    const plan = makeField(FieldType.TEXT, { fieldKey: 'plan', readOnly: true }, 'basic');
    const extra = makeField(FieldType.TEXT, {
      condition: { fieldKey: 'plan', operator: 'equals', value: 'premium' },
    });
    const fields = [plan, extra];
    const readOnlyValues = new Map([[plan.id, 'basic']]);

    const changed = applyDirectTemplateFieldLogic({
      fields,
      signedFieldValues: [{ fieldId: plan.id, value: 'premium' }],
      readOnlyValues,
    });

    expect(changed).toEqual({ success: false, fieldId: plan.id, reason: 'READ_ONLY_VALUE_CHANGED' });

    const showsExtra = applyDirectTemplateFieldLogic({
      fields,
      signedFieldValues: [{ fieldId: extra.id, value: 'Should be hidden' }],
      readOnlyValues,
    });

    expect(showsExtra).toEqual({ success: false, fieldId: extra.id, reason: 'HIDDEN_FIELD_HAS_VALUE' });
  });
});
