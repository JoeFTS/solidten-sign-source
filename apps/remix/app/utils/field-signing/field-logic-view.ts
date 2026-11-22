import type { EnvelopeForSigningResponse } from '@documenso/lib/server-only/envelope/get-envelope-for-recipient-signing';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import {
  diffRenderedFields,
  type FieldLogicInput,
  type FieldLogicState,
  findValuesClearedByChange,
  readFieldLogicMeta,
  resolveFieldLogic,
} from '@documenso/lib/utils/field-conditions';
import type {
  TSignEnvelopeFieldResponse,
  TSignEnvelopeFieldValue,
} from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type Konva from 'konva';

import { FieldLogicClearConfirmDialog } from '~/components/dialogs/field-logic-clear-confirm-dialog';

/**
 * The signing page works on this view of the envelope: fields hidden by their condition
 * are left out, so they are not drawn, not counted and not required. Calculated fields
 * show a live preview of their value and are read-only. The server applies the same
 * rules and never trusts this view.
 */
export const applyFieldLogicToSigningData = (data: EnvelopeForSigningResponse): EnvelopeForSigningResponse => ({
  ...data,
  envelope: {
    ...data.envelope,
    recipients: data.envelope.recipients.map((recipient) => ({
      ...recipient,
      fields: applyFieldLogicToFields(recipient.fields),
    })),
  },
  recipient: {
    ...data.recipient,
    fields: applyFieldLogicToFields(data.recipient.fields),
  },
});

const applyFieldLogicToFields = <T extends FieldLogicInput & { fieldMeta: TFieldMetaSchema | null }>(fields: T[]) => {
  const states = resolveFieldLogic(fields);

  return fields
    .filter((field) => !states.get(field.id)?.isHidden)
    .map((field) => {
      const calculatedValue = states.get(field.id)?.calculatedValue ?? null;

      if (calculatedValue === null || !field.fieldMeta) {
        return field;
      }

      const hint = calculatedValue === '' ? describeEmptyCalculatedField(fields, states.get(field.id)) : null;

      return {
        ...field,
        customText: calculatedValue,
        inserted: calculatedValue !== '',
        // An empty calculated field shows why on the field itself, in place of its label.
        fieldMeta: { ...field.fieldMeta, readOnly: true, required: false, ...(hint ? { label: hint } : {}) },
      };
    });
};

const describeEmptyCalculatedField = (
  fields: (FieldLogicInput & { fieldMeta: TFieldMetaSchema | null })[],
  state: FieldLogicState | undefined,
): string | null => {
  switch (state?.calculatedEmptyReason) {
    case 'missingSource': {
      const names = (state.missingSourceKeys ?? []).map((key) => {
        const source = fields.find((candidate) => readFieldLogicMeta(candidate.fieldMeta).fieldKey === key);
        const label = source?.fieldMeta?.label?.trim();

        return label || key;
      });

      const list = names.join(', ');

      return i18n._(msg`Fill in ${list}`);
    }
    case 'divisionByZero':
      return i18n._(msg`Cannot divide by zero`);
    case 'outOfRange':
      return i18n._(msg`Number too large`);
    case 'invalidRound':
      return i18n._(msg`Cannot round`);
    default:
      return null;
  }
};

/**
 * Put the fields returned by the sign route into the local state: the signed field and
 * any other field whose stored value the rules changed on the server.
 */
export const mergeSignedFields = (
  data: EnvelopeForSigningResponse,
  response: TSignEnvelopeFieldResponse,
): EnvelopeForSigningResponse => {
  const updates = new Map<number, EnvelopeForSigningResponse['recipient']['fields'][number]>();

  for (const field of response.affectedFields ?? []) {
    updates.set(field.id, { ...field, signature: null });
  }

  updates.set(response.signedField.id, response.signedField);

  const merge = <T extends { id: number }>(field: T): T => {
    const update = updates.get(field.id);

    return update ? { ...field, ...update } : field;
  };

  return {
    ...data,
    envelope: {
      ...data.envelope,
      recipients: data.envelope.recipients.map((recipient) => ({
        ...recipient,
        fields: recipient.fields.map(merge),
      })),
    },
    recipient: {
      ...data.recipient,
      fields: data.recipient.fields.map(merge),
    },
  };
};

/**
 * The page renderer only adds and redraws fields when their value changes. When a condition
 * turns false the field leaves the view, so its shape is taken off the canvas here; when the
 * hint on an empty calculated field changes (its label), the field is redrawn.
 */
export const removeFieldsHiddenByLogic = (
  pageLayer: Konva.Layer,
  renderedFields: Map<number, { fieldMeta?: unknown }>,
  visibleFields: { id: number; fieldMeta?: unknown }[],
) => {
  const { removedIds, changedIds } = diffRenderedFields(renderedFields, visibleFields);

  for (const fieldId of removedIds) {
    pageLayer.findOne(`#${fieldId}`)?.destroy();
    renderedFields.delete(fieldId);
  }

  // Dropping the cache entry makes the renderer draw the field again with its new label.
  for (const fieldId of changedIds) {
    renderedFields.delete(fieldId);
  }
};

/**
 * Ask the signer before a change that hides fields they already filled. Returns false when
 * the signer keeps their answers; the change is then not sent.
 */
export const confirmValuesClearedByChange = async (
  data: EnvelopeForSigningResponse,
  fieldId: number,
  fieldValue: TSignEnvelopeFieldValue,
): Promise<boolean> => {
  const field =
    data.recipient.fields.find((candidate) => candidate.id === fieldId) ??
    data.envelope.recipients.flatMap((recipient) => recipient.fields).find((candidate) => candidate.id === fieldId);

  if (!field || !fieldUsesLogicAnywhere(data)) {
    return true;
  }

  const siblingFields =
    field.recipientId === data.recipient.id
      ? data.recipient.fields
      : (data.envelope.recipients.find((recipient) => recipient.id === field.recipientId)?.fields ?? []);

  let change: { customText: string; inserted: boolean };

  try {
    change = extractFieldInsertionValues({ fieldValue, field, documentMeta: data.envelope.documentMeta });
  } catch {
    // An invalid value is refused by the server anyway; there is nothing to confirm.
    return true;
  }

  const { answerCount, fileCount } = findValuesClearedByChange(siblingFields, fieldId, change);

  if (answerCount === 0 && fileCount === 0) {
    return true;
  }

  return await FieldLogicClearConfirmDialog.call({ answerCount, fileCount });
};

const fieldUsesLogicAnywhere = (data: EnvelopeForSigningResponse) =>
  data.recipient.fields.some((field) => readFieldLogicMeta(field.fieldMeta).condition) ||
  data.envelope.recipients.some((recipient) =>
    recipient.fields.some((field) => readFieldLogicMeta(field.fieldMeta).condition),
  );
