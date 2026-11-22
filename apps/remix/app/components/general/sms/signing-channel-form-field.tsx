import { SIGNING_CHANNEL, type TSigningChannel } from '@documenso/lib/utils/sms/channels';
import { FormControl, FormDescription, FormField, FormItem, FormLabel } from '@documenso/ui/primitives/form/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Control, FieldValues, Path } from 'react-hook-form';

export type SigningChannelFormFieldProps<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  disabled?: boolean;
};

export const SigningChannelFormField = <T extends FieldValues>({
  control,
  name,
  disabled,
}: SigningChannelFormFieldProps<T>) => {
  const { t } = useLingui();

  const labels: Record<TSigningChannel, string> = {
    EMAIL: t`Email`,
    SMS: t`Text message`,
    EMAIL_AND_SMS: t`Email and text message`,
  };

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            <Trans>Send the signing link by</Trans>
          </FormLabel>

          <FormControl>
            <Select value={field.value ?? SIGNING_CHANNEL.EMAIL} onValueChange={field.onChange} disabled={disabled}>
              <SelectTrigger className="bg-background" data-testid="signing-channel-select">
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                {Object.values(SIGNING_CHANNEL).map((channel) => (
                  <SelectItem key={channel} value={channel}>
                    {labels[channel]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormControl>

          <FormDescription>
            <Trans>
              Reminders and resends use the same choice. A recipient without a mobile number gets the email. Only text
              people who agreed to receive texts.
            </Trans>
          </FormDescription>
        </FormItem>
      )}
    />
  );
};
