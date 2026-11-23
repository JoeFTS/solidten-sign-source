import { useDebouncedValue } from '@documenso/lib/client-only/hooks/use-debounced-value';
import {
  DEFAULT_RETENTION_SETTINGS,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type TRetentionSettings,
  ZRetentionSettingsSchema,
} from '@documenso/lib/utils/retention';
import { trpc } from '@documenso/trpc/react';
import type { TLifecycleSettingsScope } from '@documenso/trpc/server/lifecycle-router/lifecycle-settings.types';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plural, Trans } from '@lingui/react/macro';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { FormStickySaveBar } from './form-sticky-save-bar';
import { InheritableField } from './inheritable-field';

const ZRetentionPreferencesFormSchema = z.object({
  isInherited: z.boolean(),
  settings: ZRetentionSettingsSchema,
});

type TRetentionPreferencesFormSchema = z.infer<typeof ZRetentionPreferencesFormSchema>;

export type RetentionPreferencesFormProps = {
  scope: TLifecycleSettingsScope;
  /**
   * The stored rule. Null means "inherit" for a team and "off" for an organisation.
   */
  settings: TRetentionSettings | null;
  canInherit: boolean;
  onFormSubmit: (settings: TRetentionSettings | null) => Promise<void>;
};

export const RetentionPreferencesForm = ({
  scope,
  settings,
  canInherit,
  onFormSubmit,
}: RetentionPreferencesFormProps) => {
  const form = useForm<TRetentionPreferencesFormSchema>({
    defaultValues: {
      isInherited: canInherit && settings === null,
      settings: settings ?? DEFAULT_RETENTION_SETTINGS,
    },
    resolver: zodResolver(ZRetentionPreferencesFormSchema),
  });

  const isInherited = form.watch('isInherited');
  const draft = form.watch('settings');

  const debouncedDraft = useDebouncedValue(draft, 400);
  const isDraftValid = ZRetentionSettingsSchema.safeParse(debouncedDraft).success;

  const { data: preview, isFetching: isPreviewLoading } = trpc.lifecycle.previewRetention.useQuery(
    { scope, settings: debouncedDraft },
    { enabled: isDraftValid && !isInherited && debouncedDraft.enabled },
  );

  const handleFormSubmit = form.handleSubmit(async (values) => {
    try {
      await onFormSubmit(values.isInherited ? null : values.settings);
    } catch {
      return;
    }

    form.reset(values);
  });

  const isEditable = !isInherited;

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit}>
        <fieldset className="flex h-full flex-col gap-y-6" disabled={form.formState.isSubmitting}>
          <InheritableField
            canInherit={canInherit}
            isInherited={isInherited}
            label={<Trans>Delete finished documents automatically</Trans>}
            testId="retention"
          >
            <Select
              value={isInherited ? 'inherit' : draft.enabled ? 'on' : 'off'}
              onValueChange={(value) => {
                form.setValue('isInherited', value === 'inherit', { shouldDirty: true });

                if (value !== 'inherit') {
                  form.setValue('settings.enabled', value === 'on', { shouldDirty: true });
                }
              }}
            >
              <SelectTrigger className="bg-background" data-testid="retention-enabled-select">
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                {canInherit && (
                  <SelectItem value="inherit">
                    <Trans>Inherit from organisation</Trans>
                  </SelectItem>
                )}
                <SelectItem value="off">
                  <Trans>Off</Trans>
                </SelectItem>
                <SelectItem value="on">
                  <Trans>On</Trans>
                </SelectItem>
              </SelectContent>
            </Select>

            <FormDescription>
              <Trans>
                Off by default. Drafts, documents waiting for signatures and templates are never touched. The audit log
                is kept.
              </Trans>
            </FormDescription>
          </InheritableField>

          {isEditable && draft.enabled && (
            <>
              <FormField
                control={form.control}
                name="settings.action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      <Trans>What to do</Trans>
                    </FormLabel>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="bg-background" data-testid="retention-action-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="SOFT_DELETE">
                            <Trans>Delete (hide from lists, keep the files)</Trans>
                          </SelectItem>
                          <SelectItem value="PURGE">
                            <Trans>Delete permanently (remove the files)</Trans>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="settings.days"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      <Trans>Days after the document finished</Trans>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={RETENTION_MIN_DAYS}
                        max={RETENTION_MAX_DAYS}
                        value={Number.isNaN(field.value) ? '' : field.value}
                        onChange={(event) => field.onChange(event.target.valueAsNumber)}
                        data-testid="retention-days-input"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="space-y-2">
                <FormField
                  control={form.control}
                  name="settings.includeRejected"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                        />
                      </FormControl>
                      <FormLabel>
                        <Trans>Also rejected documents</Trans>
                      </FormLabel>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="settings.includeCancelled"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                        />
                      </FormControl>
                      <FormLabel>
                        <Trans>Also canceled documents</Trans>
                      </FormLabel>
                    </FormItem>
                  )}
                />
              </div>

              <Alert variant={draft.action === 'PURGE' ? 'destructive' : 'neutral'}>
                <AlertDescription data-testid="retention-preview">
                  {!isDraftValid || preview === undefined ? (
                    isPreviewLoading ? (
                      <Trans>Counting documents…</Trans>
                    ) : (
                      <Trans>Enter a number of days to see how many documents this affects.</Trans>
                    )
                  ) : (
                    <Plural
                      value={preview.count}
                      one="This rule would affect # document right now."
                      other="This rule would affect # documents right now."
                    />
                  )}{' '}
                  {draft.action === 'PURGE' && <Trans>Permanently deleted documents cannot be recovered.</Trans>}
                </AlertDescription>
              </Alert>
            </>
          )}

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
