import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  diffRenderedFields,
  dropAutoInsertsOfHiddenFields,
  type FieldLogicInput,
  fieldsContainUnsignedRequiredVisibleField,
  findValuesClearedByChange,
  getHiddenFieldIds,
  keepFieldLogicMeta,
} from './field-conditions';
import { findNewFieldLogicErrors, formatFieldLogicErrors, validateFieldLogic } from './field-logic-validation';

let nextId = 1;

const makeField = (
  type: FieldType,
  fieldMeta: Record<string, unknown>,
  overrides: Partial<FieldLogicInput> = {},
): FieldLogicInput & { page: number } => ({
  id: nextId++,
  type,
  recipientId: 1,
  envelopeItemId: 'item-1',
  inserted: false,
  customText: '',
  page: 1,
  fieldMeta: { type: type.toLowerCase(), ...fieldMeta },
  ...overrides,
});

const checkbox = (fieldKey: string, overrides: Partial<FieldLogicInput> = {}) =>
  makeField(
    FieldType.CHECKBOX,
    {
      fieldKey,
      values: [
        { id: 1, checked: false, value: 'Yes' },
        { id: 2, checked: false, value: 'Later' },
      ],
    },
    overrides,
  );

const dependent = (condition: Record<string, unknown>, overrides: Partial<FieldLogicInput> = {}, meta = {}) =>
  makeField(FieldType.TEXT, { required: true, condition, ...meta }, overrides);

describe('field conditions', () => {
  it('shows a field only while the checkbox option is checked', () => {
    const source = checkbox('agree');
    const field = dependent({ fieldKey: 'agree', operator: 'checked', value: 'Yes' });

    expect(getHiddenFieldIds([source, field]).has(field.id)).toBe(true);

    const checkedOther = { ...source, inserted: true, customText: '[1]' };
    expect(getHiddenFieldIds([checkedOther, field]).has(field.id)).toBe(true);

    const checkedYes = { ...source, inserted: true, customText: '[0]' };
    expect(getHiddenFieldIds([checkedYes, field]).has(field.id)).toBe(false);
  });

  it('applies notChecked, equals and notEmpty', () => {
    const source = checkbox('agree');
    const notChecked = dependent({ fieldKey: 'agree', operator: 'notChecked' });

    const amount = makeField(FieldType.NUMBER, { fieldKey: 'amount', numberFormat: '123.456.789,00' });
    const equalsAmount = dependent({ fieldKey: 'amount', operator: 'equals', value: '1.000,5' });
    const hasAmount = dependent({ fieldKey: 'amount', operator: 'notEmpty' });

    const empty = getHiddenFieldIds([source, notChecked, amount, equalsAmount, hasAmount]);
    expect([empty.has(notChecked.id), empty.has(equalsAmount.id), empty.has(hasAmount.id)]).toEqual([
      false,
      true,
      true,
    ]);

    const filled = getHiddenFieldIds([
      { ...source, inserted: true, customText: '[0]' },
      notChecked,
      { ...amount, inserted: true, customText: '1000,50' },
      equalsAmount,
      hasAmount,
    ]);
    expect([filled.has(notChecked.id), filled.has(equalsAmount.id), filled.has(hasAmount.id)]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('treats a hidden source as empty, so a chain hides together', () => {
    const first = checkbox('first');
    const second = makeField(FieldType.TEXT, {
      fieldKey: 'second',
      condition: { fieldKey: 'first', operator: 'checked' },
    });
    const third = dependent({ fieldKey: 'second', operator: 'notEmpty' });

    // A stale value on the hidden middle field must not keep the last one visible.
    const hidden = getHiddenFieldIds([first, { ...second, inserted: true, customText: 'stale' }, third]);

    expect(hidden.has(second.id)).toBe(true);
    expect(hidden.has(third.id)).toBe(true);
  });

  it('hides fields whose source is missing, on another recipient or on another document', () => {
    const otherRecipient = checkbox('agree', { recipientId: 2, inserted: true, customText: '[0]' });
    const otherDocument = checkbox('terms', { envelopeItemId: 'item-2', inserted: true, customText: '[0]' });

    const missing = dependent({ fieldKey: 'deleted', operator: 'notChecked' });
    const crossRecipient = dependent({ fieldKey: 'agree', operator: 'checked' });
    const crossDocument = dependent({ fieldKey: 'terms', operator: 'checked' });

    const hidden = getHiddenFieldIds([otherRecipient, otherDocument, missing, crossRecipient, crossDocument]);

    expect([hidden.has(missing.id), hidden.has(crossRecipient.id), hidden.has(crossDocument.id)]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('hides every field on a cycle instead of looping', () => {
    const a = makeField(FieldType.TEXT, { fieldKey: 'a', condition: { fieldKey: 'b', operator: 'notEmpty' } });
    const b = makeField(FieldType.TEXT, { fieldKey: 'b', condition: { fieldKey: 'a', operator: 'notEmpty' } });
    const self = makeField(FieldType.TEXT, { fieldKey: 'c', condition: { fieldKey: 'c', operator: 'notEmpty' } });

    const hidden = getHiddenFieldIds([
      { ...a, inserted: true, customText: 'x' },
      { ...b, inserted: true, customText: 'y' },
      self,
    ]);

    expect([hidden.has(a.id), hidden.has(b.id), hidden.has(self.id)]).toEqual([true, true, true]);
  });

  it('does not count a hidden required field as unsigned', () => {
    const source = checkbox('agree');
    const field = dependent({ fieldKey: 'agree', operator: 'checked' });

    const asFields = (fields: FieldLogicInput[]) =>
      fields as Parameters<typeof fieldsContainUnsignedRequiredVisibleField>[0];

    expect(fieldsContainUnsignedRequiredVisibleField(asFields([source, field]))).toBe(false);
    expect(
      fieldsContainUnsignedRequiredVisibleField(asFields([{ ...source, inserted: true, customText: '[0]' }, field])),
    ).toBe(true);
  });

  it('drops send-time inserts of hidden editable fields but keeps read-only ones', () => {
    const source = checkbox('agree');
    const email = makeField(FieldType.EMAIL, { condition: { fieldKey: 'agree', operator: 'checked' } });
    const note = makeField(FieldType.TEXT, {
      readOnly: true,
      text: 'Fixed',
      condition: { fieldKey: 'agree', operator: 'checked' },
    });

    const inserts = [
      { fieldId: email.id, customText: 'a@b.c' },
      { fieldId: note.id, customText: 'Fixed' },
    ];

    dropAutoInsertsOfHiddenFields([source, email, note], inserts);

    expect(inserts.map((insert) => insert.fieldId)).toEqual([note.id]);
  });

  it('keeps the rules when a per-type form emits only its own keys', () => {
    const previous = { type: 'text', label: 'Old', fieldKey: 'k', condition: { fieldKey: 'x', operator: 'notEmpty' } };

    expect(keepFieldLogicMeta(previous, { type: 'text', label: 'New' })).toEqual({ ...previous, label: 'New' });
    expect(keepFieldLogicMeta(previous, { type: 'text', label: 'New', condition: undefined })).toEqual({
      type: 'text',
      label: 'New',
      fieldKey: 'k',
      condition: undefined,
    });
  });
});

describe('validateFieldLogic for conditions', () => {
  it('accepts a valid condition and rejects a dangling key only in strict mode', () => {
    const source = checkbox('agree');
    const field = dependent({ fieldKey: 'agree', operator: 'checked', value: 'Yes' });
    const dangling = dependent({ fieldKey: 'gone', operator: 'notEmpty' });

    expect(validateFieldLogic([source, field, dangling])).toEqual([]);
    expect(validateFieldLogic([source, field, dangling], { strict: true }).map((error) => error.fieldId)).toEqual([
      dangling.id,
    ]);
  });

  it('rejects cycles, duplicate keys, cross-recipient and cross-document sources', () => {
    const a = makeField(FieldType.TEXT, { fieldKey: 'a', condition: { fieldKey: 'b', operator: 'notEmpty' } });
    const b = makeField(FieldType.TEXT, { fieldKey: 'b', condition: { fieldKey: 'a', operator: 'notEmpty' } });
    const self = makeField(FieldType.TEXT, { fieldKey: 'self', condition: { fieldKey: 'self', operator: 'notEmpty' } });

    const duplicateOne = makeField(FieldType.TEXT, { fieldKey: 'dup' });
    const duplicateTwo = makeField(FieldType.TEXT, { fieldKey: 'dup' });

    const otherRecipient = checkbox('theirs', { recipientId: 2 });
    const otherDocument = checkbox('elsewhere', { envelopeItemId: 'item-2' });
    const crossRecipient = dependent({ fieldKey: 'theirs', operator: 'checked' });
    const crossDocument = dependent({ fieldKey: 'elsewhere', operator: 'checked' });

    const errors = validateFieldLogic([
      a,
      b,
      self,
      duplicateOne,
      duplicateTwo,
      otherRecipient,
      otherDocument,
      crossRecipient,
      crossDocument,
    ]);

    const failingIds = new Set(errors.map((error) => error.fieldId));

    for (const field of [a, b, self, duplicateOne, duplicateTwo, crossRecipient, crossDocument]) {
      expect(failingIds.has(field.id)).toBe(true);
    }

    expect(failingIds.has(otherRecipient.id)).toBe(false);
    expect(errors.find((error) => error.fieldId === a.id)?.message).toContain('loop');
    expect(errors.find((error) => error.fieldId === crossRecipient.id)?.message).toContain('another recipient');
    expect(errors.find((error) => error.fieldId === crossDocument.id)?.message).toContain('another document');
  });

  it('rejects operators and values the source cannot satisfy', () => {
    const text = makeField(FieldType.TEXT, { fieldKey: 'note' });
    const signature = makeField(FieldType.SIGNATURE, { fieldKey: 'sig' });
    const box = checkbox('box');

    const checkedOnText = dependent({ fieldKey: 'note', operator: 'checked' });
    const equalsOnSignature = dependent({ fieldKey: 'sig', operator: 'equals', value: 'x' });
    const unknownOption = dependent({ fieldKey: 'box', operator: 'equals', value: 'Maybe' });
    const equalsWithoutValue = dependent({ fieldKey: 'note', operator: 'equals' });

    const failingIds = new Set(
      validateFieldLogic([
        text,
        signature,
        box,
        checkedOnText,
        equalsOnSignature,
        unknownOption,
        equalsWithoutValue,
      ]).map((error) => error.fieldId),
    );

    expect([...failingIds].sort()).toEqual(
      [checkedOnText.id, equalsOnSignature.id, unknownOption.id, equalsWithoutValue.id].sort(),
    );
  });
});

describe('findValuesClearedByChange', () => {
  it('counts the typed answers and files a change would clear, and nothing else', () => {
    const source = checkbox('agree', { inserted: true, customText: '[0]' });
    const answer = dependent({ fieldKey: 'agree', operator: 'checked' }, { inserted: true, customText: 'typed' });
    const emptyAnswer = dependent({ fieldKey: 'agree', operator: 'checked' });
    const readOnly = dependent(
      { fieldKey: 'agree', operator: 'checked' },
      { inserted: true, customText: 'sender' },
      { readOnly: true },
    );
    const files = makeField(
      FieldType.FILE,
      { condition: { fieldKey: 'agree', operator: 'checked' } },
      { inserted: true, customText: 'a.pdf, b.png' },
    );
    const unrelated = makeField(FieldType.TEXT, {}, { inserted: true, customText: 'stays' });

    const fields = [source, answer, emptyAnswer, readOnly, files, unrelated];

    const unticked = findValuesClearedByChange(fields, source.id, { customText: '', inserted: false });

    expect(unticked.fields.map((field) => field.id)).toEqual([answer.id, files.id]);
    expect([unticked.answerCount, unticked.fileCount]).toEqual([1, 2]);

    const stillTicked = findValuesClearedByChange(fields, source.id, { customText: '[0,1]', inserted: true });

    expect([stillTicked.answerCount, stillTicked.fileCount]).toEqual([0, 0]);
  });
});

describe('formatFieldLogicErrors', () => {
  it('says a duplicate key once although both fields report it', () => {
    const one = makeField(FieldType.TEXT, { fieldKey: 'dup' });
    const two = makeField(FieldType.TEXT, { fieldKey: 'dup' });

    const errors = validateFieldLogic([one, two]);

    expect(errors).toHaveLength(2);
    expect(formatFieldLogicErrors(errors)).toBe('The field key "dup" is used by more than one field.');
  });
});

describe('diffRenderedFields', () => {
  it('finds fields that left the view and fields whose hint changed', () => {
    const rendered = new Map<number, { fieldMeta?: unknown }>([
      [1, { fieldMeta: { label: 'Fill in Rate' } }],
      [2, { fieldMeta: { label: 'Total' } }],
      [3, { fieldMeta: { label: 'Gone' } }],
    ]);

    expect(
      diffRenderedFields(rendered, [
        { id: 1, fieldMeta: { label: 'Fill in Hours' } },
        { id: 2, fieldMeta: { label: 'Total' } },
      ]),
    ).toEqual({ removedIds: [3], changedIds: [1] });
  });
});

describe('findNewFieldLogicErrors', () => {
  it('reports only the problems a change adds', () => {
    const a = makeField(FieldType.TEXT, { fieldKey: 'a' });
    const b = makeField(FieldType.TEXT, { fieldKey: 'b', condition: { fieldKey: 'a', operator: 'notEmpty' } });

    const loop = {
      ...a,
      fieldMeta: { ...(a.fieldMeta as object), condition: { fieldKey: 'b', operator: 'notEmpty' } },
    };
    const harmless = { ...a, fieldMeta: { ...(a.fieldMeta as object), label: 'Company' } };

    expect(findNewFieldLogicErrors([a, b], [loop, b]).join(' ')).toContain('loop');
    expect(findNewFieldLogicErrors([a, b], [harmless, b])).toEqual([]);
    // An existing problem is not reported again as new.
    expect(findNewFieldLogicErrors([loop, b], [loop, b])).toEqual([]);
  });
});
