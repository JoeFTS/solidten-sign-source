import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';

import { BooleanPreferencesForm } from '~/components/forms/boolean-preferences-form';

type CommentSettingsValues = {
  commentsEnabled: boolean | null;
  commentsSharedThread: boolean | null;
};

export type CommentSettingsSectionProps = {
  canInherit: boolean;
  values: CommentSettingsValues;
  onSubmit: (values: CommentSettingsValues) => Promise<void>;
};

export const CommentSettingsSection = ({ canInherit, values, onSubmit }: CommentSettingsSectionProps) => {
  const { t } = useLingui();
  const { toast } = useToast();

  return (
    <section className="mt-12" data-testid="comment-settings">
      <h3 className="font-semibold text-lg">
        <Trans>Comments</Trans>
      </h3>

      <p className="mt-1 mb-6 text-muted-foreground text-sm">
        <Trans>Defaults for new documents. The sender can change them on each document.</Trans>
      </p>

      <BooleanPreferencesForm
        canInherit={canInherit}
        settings={values}
        fields={[
          {
            name: 'commentsEnabled',
            label: <Trans>Signers can ask questions</Trans>,
            description: (
              <Trans>
                Before signing, a signer can leave a question or a note, and your team can reply. Comments close when
                the document is completed, rejected or cancelled.
              </Trans>
            ),
            testId: 'comments-enabled',
            trueLabel: <Trans>On</Trans>,
            falseLabel: <Trans>Off</Trans>,
          },
          {
            name: 'commentsSharedThread',
            label: <Trans>All recipients share one thread</Trans>,
            description: <Trans>When off, each recipient sees only their own conversation with your team.</Trans>,
            testId: 'comments-shared-thread',
            trueLabel: <Trans>One shared thread</Trans>,
            falseLabel: <Trans>One thread per recipient</Trans>,
          },
        ]}
        onFormSubmit={async (data) => {
          try {
            await onSubmit({
              commentsEnabled: data.commentsEnabled ?? null,
              commentsSharedThread: data.commentsSharedThread ?? null,
            });

            toast({ title: t`Comment settings updated` });
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
