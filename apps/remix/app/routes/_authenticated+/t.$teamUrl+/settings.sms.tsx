import { trpc } from '@documenso/trpc/react';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { useLingui } from '@lingui/react/macro';
import { Loader } from 'lucide-react';

import { SmsPreferencesForm } from '~/components/forms/sms-preferences-form';
import { SettingsHeader } from '~/components/general/settings-header';
import { useCurrentTeam } from '~/providers/team';

export default function TeamSettingsSmsPage() {
  const team = useCurrentTeam();

  const { t } = useLingui();
  const { toast } = useToast();

  const { data, isLoading, refetch } = trpc.sms.getTeamSettings.useQuery({ teamId: team.id });

  const { mutateAsync: updateSettings } = trpc.sms.updateTeamSettings.useMutation();

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center rounded-lg py-32">
        <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <SettingsHeader title={t`Text messages`} subtitle={t`Send signing links by text message for this team.`} />

      {!data.isProviderConfigured ? (
        <p className="text-muted-foreground text-sm">{t`Text messages are not set up on this server.`}</p>
      ) : (
        <SmsPreferencesForm
          canInherit={true}
          enabled={data.team.enabled}
          senderLabel={data.team.senderLabel}
          fallbackSenderLabel={data.senderLabel}
          onFormSubmit={async ({ enabled, senderLabel }) => {
            try {
              await updateSettings({ teamId: team.id, enabled, senderLabel });
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
