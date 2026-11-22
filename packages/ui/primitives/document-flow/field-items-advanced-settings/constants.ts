// Solid Ten: labels only. The grammar of each format lives in
// packages/lib/utils/field-number-value.ts, so there is one pattern per format.
export const numberFormatValues = [
  {
    label: '123,456,789.00',
    value: '123,456,789.00',
  },
  {
    label: '123.456.789,00',
    value: '123.456.789,00',
  },
  {
    label: '123456,789.00',
    value: '123456,789.00',
  },
];

export enum CheckboxValidationRules {
  SELECT_AT_LEAST = 'Select at least',
  SELECT_EXACTLY = 'Select exactly',
  SELECT_AT_MOST = 'Select at most',
}

export const checkboxValidationRules = ['Select at least', 'Select exactly', 'Select at most'];
export const checkboxValidationLength = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const checkboxValidationSigns = [
  {
    label: 'Select at least',
    value: '>=',
  },
  {
    label: 'Select exactly',
    value: '=',
  },
  {
    label: 'Select at most',
    value: '<=',
  },
] as const;
