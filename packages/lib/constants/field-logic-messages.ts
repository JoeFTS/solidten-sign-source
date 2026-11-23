import { msg } from '@lingui/core/macro';

/**
 * Solid Ten Sign: texts of the "Formula" box (conditional and calculated fields).
 *
 * The examples contain double curly brackets. Written inside a message they are read as ICU
 * placeholders and the sender saw "For example: {} * {}". Passed as values, they show as written.
 */
export const FIELD_LOGIC_FORMULA_EXAMPLE = '{{price}} * {{quantity}}';

export const FIELD_LOGIC_KEY_EXAMPLE = '{{price}}';

export const FIELD_LOGIC_FORMULA_PLACEHOLDER = msg`For example: ${FIELD_LOGIC_FORMULA_EXAMPLE}`;

export const FIELD_LOGIC_FORMULA_HINT = msg`Use the keys of other number fields of this recipient, for example ${FIELD_LOGIC_KEY_EXAMPLE}. You can use + - * /, brackets, SUM, MIN, MAX and ROUND(value, digits). The signer cannot change a calculated field, and it is never required.`;
