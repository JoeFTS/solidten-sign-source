import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';

import { BooleanPreferencesForm } from '~/components/forms/boolean-preferences-form';

export type InPersonSettingsSectionProps = {
  canInherit: boolean;
  value: boolean | null;
  onSubmit: (value: boolean | null) => Promise<void>;
};

export const InPersonSettingsSection = ({ canInherit, value, onSubmit }: InPersonSettingsSectionProps) => {
  const { t } = useLingui();
  const { toast } = useToast();

  return (
    <section className="mt-12" data-testid="in-person-settings">
      <h3 className="font-semibold text-lg">
        <Trans>In-person signing</Trans>
      </h3>

      <p className="mt-1 mb-6 text-muted-foreground text-sm">
        <Trans>Let staff hand their device to signers who are with them.</Trans>
      </p>

      <BooleanPreferencesForm
        canInherit={canInherit}
        settings={{ allowInPersonSigning: value }}
        fields={[
          {
            name: 'allowInPersonSigning',
            label: <Trans>Staff can host signing in person</Trans>,
            description: (
              <Trans>
                Each signer confirms their name on the host's device, and can be asked for a code sent to their email.
                The audit log and certificate record who hosted the signing.
              </Trans>
            ),
            testId: 'allow-in-person-signing',
          },
        ]}
        onFormSubmit={async (data) => {
          try {
            await onSubmit(data.allowInPersonSigning ?? null);

            toast({ title: t`In-person signing settings updated` });
          } catch (err) {
            toast({
              title: t`Something went wrong!`,
              description: t`We could not save your settings. Please try again.`,
              variant: 'destructive',
            });

            throw err;
          }
        }}
      />
    </section>
  );
};
