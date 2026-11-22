import type { TRetentionSettings } from '@documenso/lib/utils/retention';
import { trpc } from '@documenso/trpc/react';
import type { TLifecycleSettingsScope } from '@documenso/trpc/server/lifecycle-router/lifecycle-settings.types';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader } from 'lucide-react';

import {
  ReassignPreferencesForm,
  type TReassignPreferencesFormSchema,
} from '~/components/forms/reassign-preferences-form';
import { RetentionPreferencesForm } from '~/components/forms/retention-preferences-form';
import { CommentSettingsSection } from '~/components/general/comments/comment-settings-section';
import { InPersonSettingsSection } from '~/components/general/in-person/in-person-settings-section';
import { SettingsHeader } from '~/components/general/settings-header';

export type LifecycleSettingsPageProps = {
  scope: TLifecycleSettingsScope;
};

/**
 * Settings for what may happen to a document after it is sent: reassignment and retention.
 */
export const LifecycleSettingsPage = ({ scope }: LifecycleSettingsPageProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const canInherit = scope.type === 'team';

  const { data, isLoading } = trpc.lifecycle.getSettings.useQuery({ scope });

  const { mutateAsync: updateSettings } = trpc.lifecycle.updateSettings.useMutation({
    onSuccess: async () => {
      await utils.lifecycle.getSettings.invalidate();
    },
  });

  const onReassignSubmit = async (values: TReassignPreferencesFormSchema) => {
    try {
      await updateSettings({ scope, data: values });

      toast({
        title: t`Reassignment settings updated`,
      });
    } catch (err) {
      toast({
        title: t`Something went wrong!`,
        description: t`We could not save your settings. Please try again.`,
        variant: 'destructive',
      });

      throw err;
    }
  };

  const onRetentionSubmit = async (retentionSettings: TRetentionSettings | null) => {
    try {
      await updateSettings({ scope, data: { retentionSettings } });

      toast({
        title: t`Retention settings updated`,
      });
    } catch (err) {
      toast({
        title: t`Something went wrong!`,
        description: t`We could not save your settings. Please try again.`,
        variant: 'destructive',
      });

      throw err;
    }
  };

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center rounded-lg py-32">
        <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const values = canInherit && data.team ? data.team : data.organisation;

  return (
    <div>
      <SettingsHeader
        title={t`Document lifecycle`}
        subtitle={
          canInherit
            ? t`Choose who may reassign signing requests and how long finished documents are kept for this team.`
            : t`Choose who may reassign signing requests and how long finished documents are kept. Teams inherit these settings by default.`
        }
      />

      <section data-testid="reassign-settings">
        <ReassignPreferencesForm
          canInherit={canInherit}
          settings={{
            allowSenderReassign: values.allowSenderReassign,
            allowSignerReassign: values.allowSignerReassign,
          }}
          onFormSubmit={onReassignSubmit}
        />
      </section>

      <InPersonSettingsSection
        canInherit={canInherit}
        value={values.allowInPersonSigning}
        onSubmit={async (allowInPersonSigning) => {
          await updateSettings({ scope, data: { allowInPersonSigning } });
        }}
      />

      <CommentSettingsSection
        canInherit={canInherit}
        values={{ commentsEnabled: values.commentsEnabled, commentsSharedThread: values.commentsSharedThread }}
        onSubmit={async (data) => {
          await updateSettings({ scope, data });
        }}
      />

      <section className="mt-12" data-testid="retention-settings">
        <h3 className="font-semibold text-lg">
          <Trans>Retention</Trans>
        </h3>

        <p className="mt-1 mb-6 text-muted-foreground text-sm">
          <Trans>Delete finished documents a set number of days after they were completed.</Trans>
        </p>

        <RetentionPreferencesForm
          scope={scope}
          canInherit={canInherit}
          settings={values.retentionSettings}
          onFormSubmit={onRetentionSubmit}
        />
      </section>
    </div>
  );
};
