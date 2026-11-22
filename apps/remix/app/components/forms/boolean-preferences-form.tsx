import { Form, FormControl, FormDescription, FormField, FormMessage } from '@documenso/ui/primitives/form/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans } from '@lingui/react/macro';
import type React from 'react';
import { useForm } from 'react-hook-form';

import { FormStickySaveBar } from './form-sticky-save-bar';
import { InheritableField } from './inheritable-field';

export type BooleanPreferenceValues = Record<string, boolean | null>;

export type BooleanPreferenceField = {
  name: string;
  label: React.ReactNode;
  description: React.ReactNode;
  testId: string;
  trueLabel?: React.ReactNode;
  falseLabel?: React.ReactNode;
};

export type BooleanPreferencesFormProps = {
  fields: BooleanPreferenceField[];
  settings: BooleanPreferenceValues;
  canInherit: boolean;
  onFormSubmit: (data: BooleanPreferenceValues) => Promise<void>;
};

const toSelectValue = (value: boolean | null) => (value === null ? 'inherit' : String(value));
const fromSelectValue = (value: string) => (value === 'inherit' ? null : value === 'true');

/**
 * Yes / no settings where a team may inherit the organisation value.
 * Same look as the reassignment settings.
 */
export const BooleanPreferencesForm = ({ fields, settings, canInherit, onFormSubmit }: BooleanPreferencesFormProps) => {
  const form = useForm<BooleanPreferenceValues>({
    defaultValues: settings,
  });

  const handleFormSubmit = form.handleSubmit(async (data) => {
    try {
      await onFormSubmit(data);
    } catch {
      return;
    }

    form.reset(data);
  });

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit}>
        <fieldset className="flex h-full flex-col gap-y-6" disabled={form.formState.isSubmitting}>
          {fields.map((preference) => (
            <FormField
              key={preference.name}
              control={form.control}
              name={preference.name}
              render={({ field }) => (
                <InheritableField
                  canInherit={canInherit}
                  isInherited={field.value === null}
                  label={preference.label}
                  testId={preference.testId}
                >
                  <FormControl>
                    <Select
                      value={toSelectValue(field.value ?? null)}
                      onValueChange={(next) => field.onChange(fromSelectValue(next))}
                    >
                      <SelectTrigger className="bg-background" data-testid={`${preference.testId}-select`}>
                        <SelectValue />
                      </SelectTrigger>

                      <SelectContent>
                        {canInherit && (
                          <SelectItem value="inherit">
                            <Trans>Inherit from organisation</Trans>
                          </SelectItem>
                        )}
                        <SelectItem value="true">{preference.trueLabel ?? <Trans>Allowed</Trans>}</SelectItem>
                        <SelectItem value="false">{preference.falseLabel ?? <Trans>Not allowed</Trans>}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>

                  <FormDescription>{preference.description}</FormDescription>

                  <FormMessage />
                </InheritableField>
              )}
            />
          ))}

          <FormStickySaveBar
            isDirty={form.formState.isDirty}
            isSubmitting={form.formState.isSubmitting}
            onReset={() => form.reset()}
          />
        </fieldset>
      </form>
    </Form>
  );
};
