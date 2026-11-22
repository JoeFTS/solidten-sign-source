import { z } from 'zod';

export const FIELD_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const FIELD_CONDITION_VALUE_MAX_LENGTH = 256;

export const ZFieldKeySchema = z
  .string()
  .regex(FIELD_KEY_REGEX, {
    message: 'A field key starts with a letter and has only letters, digits and underscores (64 characters at most).',
  })
  .describe(
    'A stable key that conditions and formulas use to refer to this field. Unique within the envelope. Letters, digits and underscores; starts with a letter.',
  );

export const ZFieldConditionOperatorSchema = z.enum(['checked', 'notChecked', 'equals', 'notEmpty']);

export type TFieldConditionOperator = z.infer<typeof ZFieldConditionOperatorSchema>;

export const ZFieldConditionSchema = z
  .object({
    fieldKey: ZFieldKeySchema.describe(
      'The key of the source field. It must belong to the same recipient and the same document.',
    ),
    operator: ZFieldConditionOperatorSchema.describe(
      '"checked" and "notChecked" need a checkbox or radio source; "value" then names one option, or any option when left out. "equals" compares the source value with "value". "notEmpty" is true when the source has a value.',
    ),
    value: z.string().max(FIELD_CONDITION_VALUE_MAX_LENGTH).optional(),
  })
  .describe(
    'Show and require this field only when the condition is true. When it is false the field is hidden, not required, cannot be signed and is not drawn into the final PDF. Version 2 envelopes only.',
  );

export type TFieldCondition = z.infer<typeof ZFieldConditionSchema>;

export const ZFieldFormulaSchema = z
  .string()
  .max(500)
  .describe(
    'Number fields only. A formula over other number fields of the same recipient on the same document, referenced as {{fieldKey}}. Supports + - * /, parentheses, unary minus, decimals, SUM, MIN, MAX and ROUND(x, digits). The server computes the value; the signer cannot change it. Division by zero or a missing source gives an empty value.',
  );
