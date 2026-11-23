import { prisma } from '@documenso/prisma';
import { isSignatureFieldType } from '@documenso/prisma/guards/is-signature-field';
import type { Field, Recipient } from '@prisma/client';
import { EnvelopeType, RecipientRole } from '@prisma/client';
import { unique } from 'remeda';
import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '../../constants/direct-templates';
import { IS_FIELD_LOGIC_ENABLED } from '../../constants/field-logic';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { fieldUsesLogic, readFieldLogicKeys, readFieldLogicMeta } from '../../utils/field-conditions';
import { getFieldLogicUnavailableReason } from '../../utils/field-logic-availability';
import {
  type FieldLogicDefinition,
  formatFieldLogicErrors,
  validateFieldLogic,
} from '../../utils/field-logic-validation';
import { findNumberFieldMetaProblem } from '../../utils/number-field-meta-check';
import { assertFileFieldsAllowed } from '../field-file/assert-file-fields';

export type AssertFieldLogicOptions = {
  envelope: {
    id: string;
    type: EnvelopeType;
    internalVersion: number;
    signatureLevel: string;
  };
  /**
   * The full set of envelope fields as it will be after the change.
   */
  fields: FieldLogicDefinition[];
  /**
   * The stored fields before the change. When the feature is turned off, rules that are
   * already stored may stay; only new or changed rules are refused.
   */
  existingFields?: Pick<FieldLogicDefinition, 'id' | 'fieldMeta'>[];
  strict?: boolean;
};

type FieldLike = {
  id?: number | null;
  type: FieldLogicDefinition['type'];
  recipientId: number;
  envelopeItemId: string;
  page?: number;
  pageNumber?: number;
  fieldMeta?: unknown;
};

/**
 * Fields that are not saved yet get negative ids, so they never collide with stored ones.
 */
export const toFieldLogicDefinitions = (fields: FieldLike[]): FieldLogicDefinition[] =>
  fields.map((field, index) => ({
    id: field.id ?? -(index + 1),
    type: field.type,
    recipientId: field.recipientId,
    envelopeItemId: field.envelopeItemId,
    page: field.page ?? field.pageNumber,
    fieldMeta: field.fieldMeta,
  }));

/**
 * Refuse a field save that would store conditions or formulas the envelope cannot honour,
 * or (Solid Ten) "Attach a file" fields where they cannot work.
 */
export const assertFieldLogicAllowed = async (options: AssertFieldLogicOptions) => {
  await assertFileFieldsAllowed(options);

  // Solid Ten: number formats and default values, on every save path (editor, API, create).
  const numberProblems = unique(options.fields.map(findNumberFieldMetaProblem).filter((problem) => problem !== null));

  if (numberProblems.length > 0) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: numberProblems.join(' ') });
  }

  assertFieldLogicRulesAllowed(options);

  await assertDirectLinkStaysUsable(options);
};

const assertFieldLogicRulesAllowed = ({
  envelope,
  fields,
  existingFields = [],
  strict = false,
}: AssertFieldLogicOptions) => {
  const logicFields = fields.filter((field) => fieldUsesLogic(field.fieldMeta));

  if (logicFields.length === 0) {
    return;
  }

  if (!IS_FIELD_LOGIC_ENABLED()) {
    const hasNewRule = logicFields.some((field) => {
      const existing = existingFields.find((existingField) => existingField.id === field.id);

      return !existing || readFieldLogicKeys(existing.fieldMeta) !== readFieldLogicKeys(field.fieldMeta);
    });

    if (hasNewRule) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Conditional and calculated fields are turned off on this server.',
      });
    }
  }

  const unavailableReason = getFieldLogicUnavailableReason(envelope);

  if (unavailableReason === 'VERSION_1') {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Conditional and calculated fields need a version 2 envelope.',
    });
  }

  if (unavailableReason === 'TSP') {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Conditional and calculated fields cannot be used with advanced or qualified signatures.',
    });
  }

  const errors = validateFieldLogic(fields, { strict });

  if (errors.length > 0) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: formatFieldLogicErrors(errors),
    });
  }
};

/**
 * Send-time check: the rules must be complete (no key that points nowhere), and every
 * signer must have a signature field that no condition can hide.
 */
export const assertFieldLogicReadyToSend = ({
  envelope,
  fields,
  recipients,
}: {
  envelope: AssertFieldLogicOptions['envelope'];
  fields: (Pick<Field, 'id' | 'type' | 'recipientId' | 'envelopeItemId' | 'page'> & { fieldMeta?: unknown })[];
  recipients: Pick<Recipient, 'id' | 'role' | 'email'>[];
}) => {
  if (!fields.some((field) => fieldUsesLogic(field.fieldMeta))) {
    return;
  }

  assertFieldLogicRulesAllowed({
    envelope,
    fields: toFieldLogicDefinitions(fields),
    existingFields: fields,
    strict: true,
  });

  const signerWithoutFixedSignature = findSignerWithoutFixedSignature(fields, recipients);

  if (signerWithoutFixedSignature) {
    throw new AppError(AppErrorCode.MISSING_SIGNATURE_FIELD, {
      message: `${describeSignerForSender(signerWithoutFixedSignature)} needs at least one signature field without a condition.`,
    });
  }
};

/** A signer who has no signature field that no condition can hide. */
const findSignerWithoutFixedSignature = <R extends Pick<Recipient, 'id' | 'role' | 'email'>>(
  fields: { type: Field['type']; recipientId: number | null; fieldMeta?: unknown }[],
  recipients: R[],
) =>
  recipients.find(
    (recipient) =>
      recipient.role === RecipientRole.SIGNER &&
      !fields.some(
        (field) =>
          field.recipientId === recipient.id &&
          isSignatureFieldType(field.type) &&
          !readFieldLogicMeta(field.fieldMeta).condition,
      ),
  );

/**
 * Solid Ten Sign (N-1): a signer as the sender knows them. The direct-link signer carries a
 * placeholder address that nobody should read, so it is named by its role.
 */
const describeSignerForSender = (recipient: Pick<Recipient, 'email'> & { name?: string | null }) => {
  if (recipient.email.toLowerCase() === DIRECT_TEMPLATE_RECIPIENT_EMAIL) {
    return 'The direct link signer';
  }

  return recipient.name || recipient.email || 'A signer';
};

/**
 * Solid Ten Sign (N-1): a template with a direct link that is on must stay usable. A field save
 * that would leave a signer with only conditional signature fields is refused here, in the
 * editor, so no visitor meets it.
 */
const assertDirectLinkStaysUsable = async ({ envelope, fields }: AssertFieldLogicOptions) => {
  if (envelope.type !== EnvelopeType.TEMPLATE || !fields.some((field) => fieldUsesLogic(field.fieldMeta))) {
    return;
  }

  const template = await prisma.envelope.findUnique({
    where: { id: envelope.id },
    select: {
      directLink: { select: { enabled: true } },
      recipients: true,
      fields: { select: { type: true, recipientId: true, fieldMeta: true } },
    },
  });

  if (!template?.directLink?.enabled) {
    return;
  }

  // Only the signature rule: the other rules are checked strictly at send time, and the editor
  // may save a rule that is not complete yet. Only a save that takes a signer's last
  // unconditional signature field away is refused; a template that already lacks one is shown
  // to its owner (template page and editor alerts) and is not made worse here.
  const signer = template.recipients.find(
    (recipient) =>
      findSignerWithoutFixedSignature(fields, [recipient]) &&
      !findSignerWithoutFixedSignature(template.fields, [recipient]),
  );

  if (signer) {
    throw new AppError(AppErrorCode.MISSING_SIGNATURE_FIELD, {
      message: `${describeSignerForSender(signer)} needs at least one signature field without a condition. This template has a direct link that is on, so visitors could not submit it. Keep one signature field without a condition, or turn the direct link off first.`,
    });
  }
};
