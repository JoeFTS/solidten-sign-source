import { Form, FormControl, FormDescription, FormField, FormMessage } from '@documenso/ui/primitives/form/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trans } from '@lingui/react/macro';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { FormStickySaveBar } from './form-sticky-save-bar';
import { InheritableField } from './inheritable-field';

const ZReassignPreferencesFormSchema = z.object({
  allowSenderReassign: z.boolean().nullable(),
  allowSignerReassign: z.boolean().nullable(),
});

export type TReassignPreferencesFormSchema = z.infer<typeof ZReassignPreferencesFormSchema>;

export type ReassignPreferencesFormProps = {
  settings: TReassignPreferencesFormSchema;
  canInherit: boolean;
  onFormSubmit: (data: TReassignPreferencesFormSchema) => Promise<void>;
};

const toSelectValue = (value: boolean | null) => (value === null ? 'inherit' : String(value));
const fromSelectValue = (value: string) => (value === 'inherit' ? null : value === 'true');

export const ReassignPreferencesForm = ({ settings, canInherit, onFormSubmit }: ReassignPreferencesFormProps) => {
  const form = useForm<TReassignPreferencesFormSchema>({
    defaultValues: settings,
    resolver: zodResolver(ZReassignPreferencesFormSchema),
  });

  const handleFormSubmit = form.handleSubmit(async (data) => {
    try {
      await onFormSubmit(data);
    } catch {
      return;
    }

    form.reset(data);
  });

  const renderSelect = (value: boolean | null, onChange: (value: boolean | null) => void, testId: string) => (
    <Select value={toSelectValue(value)} onValueChange={(next) => onChange(fromSelectValue(next))}>
      <SelectTrigger className="bg-background" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>

      <SelectContent>
        {canInherit && (
          <SelectItem value="inherit">
            <Trans>Inherit from organisation</Trans>
          </SelectItem>
        )}
        <SelectItem value="true">
          <Trans>Allowed</Trans>
        </SelectItem>
        <SelectItem value="false">
          <Trans>Not allowed</Trans>
        </SelectItem>
      </SelectContent>
    </Select>
  );

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit}>
        <fieldset className="flex h-full flex-col gap-y-6" disabled={form.formState.isSubmitting}>
          <FormField
            control={form.control}
            name="allowSenderReassign"
            render={({ field }) => (
              <InheritableField
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Senders can reassign recipients</Trans>}
                testId="allow-sender-reassign"
              >
                <FormControl>{renderSelect(field.value, field.onChange, 'allow-sender-reassign-select')}</FormControl>

                <FormDescription>
                  <Trans>
                    Lets the sender hand a pending signing request to another person from the document page.
                  </Trans>
                </FormDescription>

                <FormMessage />
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="allowSignerReassign"
            render={({ field }) => (
              <InheritableField
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Signers can reassign to someone else</Trans>}
                testId="allow-signer-reassign"
              >
                <FormControl>{renderSelect(field.value, field.onChange, 'allow-signer-reassign-select')}</FormControl>

                <FormDescription>
                  <Trans>
                    Lets a signer who is the wrong person pass the request on from the signing page. Off by default:
                    anyone holding a forwarded link could then send your contract to an address of their choice.
                  </Trans>
                </FormDescription>

                <FormMessage />
              </InheritableField>
            )}
          />

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
