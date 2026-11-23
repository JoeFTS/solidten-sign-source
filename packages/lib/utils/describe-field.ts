/**
 * Solid Ten Sign (N-3): a field named the way a person sees it, never by its database id.
 * `the "Company" field`, or `the text field on page 2`, or `this field` when nothing is known.
 */
export type TDescribableField = {
  type?: string | null;
  page?: number | null;
  fieldMeta?: unknown;
};

const TYPE_NAMES: Record<string, string> = {
  SIGNATURE: 'signature',
  FREE_SIGNATURE: 'signature',
  INITIALS: 'initials',
  NAME: 'name',
  EMAIL: 'email',
  DATE: 'date',
  TEXT: 'text',
  NUMBER: 'number',
  RADIO: 'radio',
  CHECKBOX: 'checkbox',
  DROPDOWN: 'dropdown',
  FILE: 'attach a file',
};

const readLabel = (fieldMeta: unknown): string | null => {
  if (typeof fieldMeta !== 'object' || fieldMeta === null || Array.isArray(fieldMeta)) {
    return null;
  }

  const label = (fieldMeta as Record<string, unknown>).label;

  return typeof label === 'string' && label.trim() ? label.trim() : null;
};

export const describeFieldForUser = (field: TDescribableField | null | undefined): string => {
  if (!field) {
    return 'this field';
  }

  const label = readLabel(field.fieldMeta);
  const page = typeof field.page === 'number' && field.page > 0 ? ` on page ${field.page}` : '';

  if (label) {
    return `the "${label}" field${page}`;
  }

  const typeName = field.type ? (TYPE_NAMES[field.type] ?? field.type.toLowerCase().replace(/_/g, ' ')) : null;

  return typeName ? `the ${typeName} field${page}` : `this field${page}`;
};

/** The same, with a capital first letter, to start a sentence. */
export const describeFieldForUserAtStart = (field: TDescribableField | null | undefined): string => {
  const text = describeFieldForUser(field);

  return text.charAt(0).toUpperCase() + text.slice(1);
};
