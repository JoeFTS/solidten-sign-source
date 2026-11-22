import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Form, FormControl, FormDescription, FormField, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trans, useLingui } from '@lingui/react/macro';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { FormStickySaveBar } from './form-sticky-save-bar';
import { InheritableField } from './inheritable-field';

const ZSmsPreferencesFormSchema = z.object({
  enabled: z.enum(['true', 'false', 'inherit']),
  senderLabel: z.string().max(40),
});

export type TSmsPreferencesFormSchema = z.infer<typeof ZSmsPreferencesFormSchema>;

export type SmsPreferencesFormProps = {
  canInherit: boolean;
  enabled: boolean | null;
  senderLabel: string | null;
  /** Shown as the placeholder: what the text uses when the label is empty. */
  fallbackSenderLabel: string;
  onFormSubmit: (data: { enabled: boolean | null; senderLabel: string | null }) => Promise<void>;
};

export const SmsPreferencesForm = ({
  canInherit,
  enabled,
  senderLabel,
  fallbackSenderLabel,
  onFormSubmit,
}: SmsPreferencesFormProps) => {
  const { t } = useLingui();

  const form = useForm<TSmsPreferencesFormSchema>({
    defaultValues: {
      enabled: enabled === null ? (canInherit ? 'inherit' : 'false') : enabled ? 'true' : 'false',
      senderLabel: senderLabel ?? '',
    },
    resolver: zodResolver(ZSmsPreferencesFormSchema),
  });

  const handleFormSubmit = form.handleSubmit(async (data) => {
    try {
      await onFormSubmit({
        enabled: data.enabled === 'inherit' ? null : data.enabled === 'true',
        senderLabel: data.senderLabel.trim() === '' ? null : data.senderLabel.trim(),
      });
    } catch {
      return;
    }

    form.reset(data);
  });

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit}>
        <fieldset className="flex h-full flex-col gap-y-6" disabled={form.formState.isSubmitting}>
          <Alert variant="neutral">
            <AlertDescription>
              <Trans>
                Only text people who agreed to receive texts from you. Carriers block senders who text people without
                consent. Recipients can reply STOP at any time; Solid Ten Sign then stops texting that number.
              </Trans>
            </AlertDescription>
          </Alert>

          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <InheritableField
                canInherit={canInherit}
                isInherited={field.value === 'inherit'}
                label={<Trans>Send signing links by text message</Trans>}
                testId="sms-enabled"
              >
                <FormControl>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="bg-background" data-testid="sms-enabled-select">
                      <SelectValue />
                    </SelectTrigger>

                    <SelectContent>
                      {canInherit && <SelectItem value="inherit">{t`Inherit from organisation`}</SelectItem>}
                      <SelectItem value="true">{t`On`}</SelectItem>
                      <SelectItem value="false">{t`Off`}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>

                <FormDescription>
                  <Trans>
                    When on, senders can add a mobile number to a recipient and choose email, text or both for each
                    document. Email stays required.
                  </Trans>
                </FormDescription>

                <FormMessage />
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="senderLabel"
            render={({ field }) => (
              <InheritableField
                canInherit={canInherit}
                isInherited={field.value.trim() === ''}
                label={<Trans>Sender name in the text</Trans>}
                testId="sms-sender-label"
              >
                <FormControl>
                  <Input
                    {...field}
                    maxLength={40}
                    placeholder={fallbackSenderLabel}
                    className="bg-background"
                    data-testid="sms-sender-label-input"
                  />
                </FormControl>

                <FormDescription>
                  <Trans>Starts every text, for example "{fallbackSenderLabel}: please sign ...". Keep it short.</Trans>
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
