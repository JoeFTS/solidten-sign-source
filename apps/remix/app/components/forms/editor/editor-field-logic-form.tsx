import type { TLocalField } from '@documenso/lib/client-only/hooks/use-editor-fields';
import { IS_FIELD_LOGIC_ENABLED } from '@documenso/lib/constants/field-logic';
import { type TFieldCondition, type TFieldConditionOperator, ZFieldKeySchema } from '@documenso/lib/types/field-logic';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import { readFieldLogicMeta } from '@documenso/lib/utils/field-conditions';
import { FORMULA_MAX_LENGTH, parseFormula } from '@documenso/lib/utils/field-formula';
import { getFieldLogicUnavailableReason as getSharedFieldLogicUnavailableReason } from '@documenso/lib/utils/field-logic-availability';
import { findNewFieldLogicErrors, validateFieldLogic } from '@documenso/lib/utils/field-logic-validation';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Separator } from '@documenso/ui/primitives/separator';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { FieldType } from '@prisma/client';
import { useEffect, useMemo, useState } from 'react';

type EditorFieldLogicFormProps = {
  field: TLocalField;
  fields: TLocalField[];
  /**
   * Why rules cannot be used on this envelope, or null when they can.
   */
  unavailableReason: string | null;
  onValueChange: (value: TFieldMetaSchema) => void;
};

const NO_CONDITION = '__none__';

const OPTION_FIELD_TYPES: FieldType[] = [FieldType.CHECKBOX, FieldType.RADIO];

const getOptionValues = (fieldMeta: TFieldMetaSchema) => {
  if (!fieldMeta || !('values' in fieldMeta) || !Array.isArray(fieldMeta.values)) {
    return [];
  }

  return fieldMeta.values.map((option) => option.value).filter((value) => value !== '');
};

export const EditorFieldLogicForm = ({
  field,
  fields,
  unavailableReason,
  onValueChange,
}: EditorFieldLogicFormProps) => {
  const { t } = useLingui();

  const { fieldKey, condition, formula, formulaEmptySourcesAsZero } = readFieldLogicMeta(field.fieldMeta);

  const [keyInput, setKeyInput] = useState(fieldKey ?? '');
  const [formulaInput, setFormulaInput] = useState(formula ?? '');

  // Collapsed until asked for, so fields without rules keep the settings panel unchanged.
  const [isExpanded, setIsExpanded] = useState(Boolean(fieldKey || condition || formula));

  useEffect(() => {
    setKeyInput(fieldKey ?? '');
    setFormulaInput(formula ?? '');
    setIsExpanded(Boolean(fieldKey || condition || formula));
  }, [field.formId]);

  const isKeyInputValid = keyInput === '' || ZFieldKeySchema.safeParse(keyInput).success;

  const formulaParseResult = formulaInput.trim() ? parseFormula(formulaInput) : null;

  const sourceFields = useMemo(
    () =>
      fields.filter(
        (candidate) =>
          candidate.formId !== field.formId &&
          candidate.recipientId === field.recipientId &&
          candidate.envelopeItemId === field.envelopeItemId &&
          candidate.type !== FieldType.FREE_SIGNATURE &&
          readFieldLogicMeta(candidate.fieldMeta).fieldKey,
      ),
    [fields, field.formId, field.recipientId, field.envelopeItemId],
  );

  const sourceField = condition
    ? fields.find((candidate) => readFieldLogicMeta(candidate.fieldMeta).fieldKey === condition.fieldKey)
    : undefined;

  // Problems a change would have added; that change was kept here and not saved.
  const [refusedErrors, setRefusedErrors] = useState<string[]>([]);

  useEffect(() => {
    setRefusedErrors([]);
  }, [field.formId]);

  const errors = useMemo(() => {
    const selectedIndex = fields.findIndex((localField) => localField.formId === field.formId);

    const storedErrors = validateFieldLogic(toLogicDefinitions(fields))
      .filter((error) => error.fieldId === selectedIndex)
      .map((error) => error.message);

    return [...new Set([...storedErrors, ...refusedErrors])];
  }, [fields, field.formId, refusedErrors]);

  const updateMeta = (changes: {
    fieldKey?: string | undefined;
    condition?: TFieldCondition | undefined;
    formula?: string | undefined;
    formulaEmptySourcesAsZero?: boolean | undefined;
  }) => {
    // Explicit undefined removes the key; the editor drops undefined keys on save.
    const nextFieldMeta = { ...field.fieldMeta, ...changes } as TFieldMetaSchema;

    const nextFields = fields.map((localField) =>
      localField.formId === field.formId ? { ...localField, fieldMeta: nextFieldMeta } : localField,
    );

    // A change that would make a loop or a duplicate key is not saved: the server would
    // refuse it and the editor would show a failed save instead of the reason.
    const newErrors = findNewFieldLogicErrors(toLogicDefinitions(fields), toLogicDefinitions(nextFields));

    setRefusedErrors(newErrors);

    if (newErrors.length === 0) {
      onValueChange(nextFieldMeta);
    }
  };

  const onKeyChange = (value: string) => {
    setKeyInput(value);

    if (value === '') {
      updateMeta({ fieldKey: undefined });
      return;
    }

    if (ZFieldKeySchema.safeParse(value).success) {
      updateMeta({ fieldKey: value });
    }
  };

  const onFormulaChange = (value: string) => {
    setFormulaInput(value);

    if (!value.trim()) {
      updateMeta({ formula: undefined, formulaEmptySourcesAsZero: undefined });
      return;
    }

    // Only a formula that parses is saved, so a half-typed one never fails the autosave.
    if (parseFormula(value).success) {
      updateMeta({ formula: value });
    }
  };

  const onSourceChange = (value: string) => {
    if (value === NO_CONDITION) {
      updateMeta({ condition: undefined });
      return;
    }

    const source = fields.find((candidate) => readFieldLogicMeta(candidate.fieldMeta).fieldKey === value);
    const operator: TFieldConditionOperator =
      source && OPTION_FIELD_TYPES.includes(source.type) ? 'checked' : 'notEmpty';

    updateMeta({ condition: { fieldKey: value, operator } });
  };

  const onOperatorChange = (operator: TFieldConditionOperator) => {
    if (!condition) {
      return;
    }

    const keepsValue = operator === 'equals' || operator === 'checked' || operator === 'notChecked';

    updateMeta({ condition: { ...condition, operator, value: keepsValue ? condition.value : undefined } });
  };

  const onConditionValueChange = (value: string) => {
    if (!condition) {
      return;
    }

    updateMeta({ condition: { ...condition, value: value || undefined } });
  };

  const hasRules = Boolean(fieldKey || condition || formula);

  if (!field.fieldMeta) {
    return null;
  }

  if (unavailableReason || (!IS_FIELD_LOGIC_ENABLED() && !hasRules)) {
    return unavailableReason ? (
      <section className="mt-4">
        <Separator className="mb-4" />
        <p className="text-muted-foreground text-xs" data-testid="field-logic-unavailable">
          {unavailableReason}
        </p>
      </section>
    ) : null;
  }

  if (!isExpanded) {
    return (
      <section className="mt-4">
        <Separator className="mb-4" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          data-testid="field-logic-expand"
          onClick={() => setIsExpanded(true)}
        >
          <Trans>Set up rules</Trans>
        </Button>
      </section>
    );
  }

  const sourceOptionValues = sourceField ? getOptionValues(sourceField.fieldMeta) : [];
  const isOptionSource = sourceField ? OPTION_FIELD_TYPES.includes(sourceField.type) : false;
  const hasValueChoices = sourceField?.type === FieldType.DROPDOWN || isOptionSource;
  const needsValue = condition?.operator === 'equals';
  const canPickOption = condition?.operator === 'checked' || condition?.operator === 'notChecked';

  return (
    <section className="mt-4 flex flex-col gap-3" data-testid="field-logic-form">
      <Separator />

      <h3 className="font-semibold text-sm">
        <Trans>Rules</Trans>
      </h3>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="field-logic-key">
          <Trans>Field key</Trans>
        </Label>
        <Input
          id="field-logic-key"
          data-testid="field-logic-key"
          className="bg-background"
          value={keyInput}
          placeholder={t`For example: price`}
          onChange={(event) => onKeyChange(event.target.value.trim())}
        />
        {!isKeyInputValid && (
          <p className="text-destructive text-xs">
            <Trans>Start with a letter. Use only letters, digits and underscores.</Trans>
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          <Trans>Other fields use this key in their rules.</Trans>
        </p>
      </div>

      {field.type === FieldType.NUMBER && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="field-logic-formula">
            <Trans>Formula</Trans>
          </Label>
          <Input
            id="field-logic-formula"
            data-testid="field-logic-formula"
            className="bg-background font-mono"
            value={formulaInput}
            maxLength={FORMULA_MAX_LENGTH}
            placeholder={t`For example: {{price}} * {{quantity}}`}
            onChange={(event) => onFormulaChange(event.target.value)}
          />
          {formulaParseResult && !formulaParseResult.success && (
            <p className="text-destructive text-xs" data-testid="field-logic-formula-error">
              {formulaParseResult.error}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            <Trans>
              Use the keys of other number fields of this recipient, for example {'{{price}}'}. You can use + - * /,
              brackets, SUM, MIN, MAX and ROUND(value, digits). The signer cannot change a calculated field, and it is
              never required.
            </Trans>
          </p>

          {formula && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="field-logic-formula-empty-as-zero"
                data-testid="field-logic-formula-empty-as-zero"
                checked={formulaEmptySourcesAsZero}
                onCheckedChange={(checked) => updateMeta({ formulaEmptySourcesAsZero: checked === true || undefined })}
              />
              <Label htmlFor="field-logic-formula-empty-as-zero" className="font-normal">
                <Trans>Count empty fields as 0. When off, the result stays empty until every field is filled.</Trans>
              </Label>
            </div>
          )}
        </div>
      )}

      {field.type !== FieldType.FREE_SIGNATURE && (
        <div className="flex flex-col gap-1.5">
          <Label>
            <Trans>Show this field only when</Trans>
          </Label>

          <Select value={condition?.fieldKey ?? NO_CONDITION} onValueChange={onSourceChange}>
            <SelectTrigger className="bg-background" data-testid="field-logic-condition-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CONDITION}>
                <Trans>Always show</Trans>
              </SelectItem>
              {condition &&
                !sourceFields.some(
                  (source) => readFieldLogicMeta(source.fieldMeta).fieldKey === condition.fieldKey,
                ) && <SelectItem value={condition.fieldKey}>{condition.fieldKey}</SelectItem>}
              {sourceFields.map((source) => {
                const sourceKey = readFieldLogicMeta(source.fieldMeta).fieldKey ?? '';

                return (
                  <SelectItem key={source.formId} value={sourceKey}>
                    {sourceKey}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          {sourceFields.length === 0 && !condition && (
            <p className="text-muted-foreground text-xs">
              <Trans>Give another field of this recipient on this document a key to use it here.</Trans>
            </p>
          )}

          {condition && (
            <Select
              value={condition.operator}
              onValueChange={(value) => onOperatorChange(value as TFieldConditionOperator)}
            >
              <SelectTrigger className="bg-background" data-testid="field-logic-condition-operator">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {isOptionSource && (
                  <>
                    <SelectItem value="checked">
                      <Trans>is checked</Trans>
                    </SelectItem>
                    <SelectItem value="notChecked">
                      <Trans>is not checked</Trans>
                    </SelectItem>
                  </>
                )}
                {sourceField?.type !== FieldType.SIGNATURE && (
                  <SelectItem value="equals">
                    <Trans>equals</Trans>
                  </SelectItem>
                )}
                <SelectItem value="notEmpty">
                  <Trans>is not empty</Trans>
                </SelectItem>
              </SelectContent>
            </Select>
          )}

          {condition &&
            (needsValue || (canPickOption && sourceOptionValues.length > 1)) &&
            (hasValueChoices ? (
              <Select value={condition.value ?? ''} onValueChange={onConditionValueChange}>
                <SelectTrigger className="bg-background" data-testid="field-logic-condition-value">
                  <SelectValue placeholder={canPickOption ? t`Any option` : t`Choose a value`} />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptionValues.map((optionValue) => (
                    <SelectItem key={optionValue} value={optionValue}>
                      {optionValue}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                data-testid="field-logic-condition-value"
                className="bg-background"
                value={condition.value ?? ''}
                placeholder={t`Value`}
                onChange={(event) => onConditionValueChange(event.target.value)}
              />
            ))}
        </div>
      )}

      {errors.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="field-logic-errors">
          {errors.map((error) => (
            <li key={error} className="text-destructive text-xs">
              {error}
            </li>
          ))}
        </ul>
      )}

      {condition && sourceField && (
        <p className="text-muted-foreground text-xs">
          <Trans>
            While the rule is false the signer does not see this field, and it is left out of the final PDF.
          </Trans>
        </p>
      )}
    </section>
  );
};

export const getFieldLogicUnavailableReason = (
  envelope: { internalVersion: number; signatureLevel?: string | null },
  translate: (descriptor: MessageDescriptor) => string,
): string | null => {
  // The same rule as the server's save check (see `getFieldLogicUnavailableReason` in lib).
  switch (getSharedFieldLogicUnavailableReason(envelope)) {
    case 'VERSION_1':
      return translate(msg`Conditional and calculated fields need a version 2 envelope.`);
    case 'TSP':
      return translate(msg`Conditional and calculated fields cannot be used with advanced or qualified signatures.`);
    default:
      return null;
  }
};

const toLogicDefinitions = (fields: TLocalField[]) =>
  fields.map((localField, index) => ({
    id: index,
    type: localField.type,
    recipientId: localField.recipientId,
    envelopeItemId: localField.envelopeItemId,
    page: localField.page,
    fieldMeta: localField.fieldMeta,
  }));
