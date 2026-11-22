import { useCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';
import { trpc } from '@documenso/trpc/react';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { useLingui } from '@lingui/react/macro';
import { Loader } from 'lucide-react';

import { SmsPreferencesForm } from '~/components/forms/sms-preferences-form';
import { SettingsHeader } from '~/components/general/settings-header';

export default function OrganisationSettingsSmsPage() {
  const organisation = useCurrentOrganisation();

  const { t } = useLingui();
  const { toast } = useToast();

  const { data, isLoading, refetch } = trpc.sms.getOrganisationSettings.useQuery({
    organisationId: organisation.id,
  });

  const { mutateAsync: updateSettings } = trpc.sms.updateOrganisationSettings.useMutation();

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center rounded-lg py-32">
        <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <SettingsHeader
        title={t`Text messages`}
        subtitle={t`Send signing links by text message. Teams inherit these settings unless they override them.`}
      />

      {!data.isProviderConfigured ? (
        <p className="text-muted-foreground text-sm">{t`Text messages are not set up on this server.`}</p>
      ) : (
        <SmsPreferencesForm
          canInherit={false}
          enabled={data.enabled}
          senderLabel={data.senderLabel}
          fallbackSenderLabel={organisation.name || 'Solid Ten Sign'}
          onFormSubmit={async ({ enabled, senderLabel }) => {
            try {
              await updateSettings({ organisationId: organisation.id, enabled: enabled ?? false, senderLabel });
              await refetch();

              toast({ title: t`Text message settings updated` });
            } catch (err) {
              toast({
                title: t`Something went wrong`,
                description: t`We could not save your text message settings. Please try again.`,
                variant: 'destructive',
              });

              throw err;
            }
          }}
        />
      )}
    </div>
  );
}
