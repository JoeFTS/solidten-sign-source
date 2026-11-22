import { downloadFile } from '@documenso/lib/client-only/download-file';
import { AppError } from '@documenso/lib/errors/app-error';
import type { getPublicFormSettings } from '@documenso/lib/server-only/public-form/public-form-settings';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@documenso/ui/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Switch } from '@documenso/ui/primitives/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@documenso/ui/primitives/table';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { DownloadIcon, Settings2Icon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useCurrentTeam } from '~/providers/team';

const PER_PAGE = 20;

export type TemplatePublicFormPanelProps = {
  envelopeId: string;
};

/**
 * Settings, status and responses of the public form behind a template's direct link. Renders
 * nothing when the template has no direct link or cannot be a public form.
 */
export const TemplatePublicFormPanel = ({ envelopeId }: TemplatePublicFormPanelProps) => {
  const { t, i18n } = useLingui();
  const { toast } = useToast();
  const team = useCurrentTeam();
  const utils = trpc.useUtils();

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  const { data: settings } = trpc.publicForm.getSettings.useQuery({ envelopeId });

  const filter = {
    envelopeId,
    from: fromDate ? new Date(`${fromDate}T00:00:00`) : null,
    to: toDate ? addOneDay(new Date(`${toDate}T00:00:00`)) : null,
  };

  const { data: responses } = trpc.publicForm.findResponses.useQuery(
    { ...filter, page, perPage: PER_PAGE },
    { enabled: Boolean(settings?.form) },
  );

  const { mutateAsync: setClosed, isPending: isClosing } = trpc.publicForm.setClosed.useMutation({
    onSuccess: async () => utils.publicForm.getSettings.invalidate({ envelopeId }),
  });

  const { mutateAsync: exportResponses, isPending: isExporting } = trpc.publicForm.exportResponses.useMutation();

  if (!settings?.isSupported || !settings.form) {
    return null;
  }

  const { form } = settings;
  const isClosedBySender = Boolean(form.closedAt);

  const onToggleClosed = async () => {
    try {
      await setClosed({ envelopeId, closed: !isClosedBySender });

      toast({ title: isClosedBySender ? t`The form is open again` : t`The form is closed` });
    } catch (err) {
      toast({ title: t`Something went wrong`, description: AppError.parseError(err).message, variant: 'destructive' });
    }
  };

  const onExport = async () => {
    try {
      const { csv, filename } = await exportResponses(filter);

      downloadFile({ filename, data: new Blob([csv], { type: 'text/csv;charset=utf-8' }) });
    } catch (err) {
      toast({ title: t`Something went wrong`, description: AppError.parseError(err).message, variant: 'destructive' });
    }
  };

  return (
    <Card className="mt-8" data-testid="public-form-panel">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-x-2 text-lg">
            <Trans>Public form</Trans>
            <Badge variant={form.availability === 'OPEN' ? 'default' : 'neutral'} data-testid="public-form-status">
              {form.availability === 'OPEN' && <Trans>Open</Trans>}
              {form.availability === 'NOT_OPEN_YET' && <Trans>Not open yet</Trans>}
              {form.availability === 'CLOSED' && <Trans>Closed</Trans>}
              {form.availability === 'FULL' && <Trans>Full</Trans>}
            </Badge>
          </CardTitle>
          <CardDescription data-testid="public-form-count">
            {form.maxSubmissions !== null ? (
              <Trans>
                {form.submissionCount} of {form.maxSubmissions} responses
              </Trans>
            ) : (
              <Trans>{form.submissionCount} responses</Trans>
            )}
            {' · '}
            {form.requireVerifiedEmail ? <Trans>Email verified by code</Trans> : <Trans>Email not verified</Trans>}
          </CardDescription>
        </div>

        <div className="flex flex-wrap gap-2">
          <PublicFormSettingsDialog envelopeId={envelopeId} settings={settings} />

          <Button variant="outline" size="sm" loading={isClosing} onClick={() => void onToggleClosed()}>
            {isClosedBySender ? <Trans>Reopen form</Trans> : <Trans>Close form</Trans>}
          </Button>
        </div>
      </CardHeader>

      {!settings.isCaptchaConfigured && (
        <div className="px-6 pb-4">
          <Alert variant="warning" data-testid="public-form-captcha-warning">
            <AlertDescription>
              <Trans>
                Bot protection (Cloudflare Turnstile) is not set up on this server. Anyone can submit this form or ask
                for codes, limited only by rate limits and daily caps. Ask your administrator to set
                NEXT_PRIVATE_TURNSTILE_SECRET_KEY and NEXT_PUBLIC_TURNSTILE_SITE_KEY.
              </Trans>
            </AlertDescription>
          </Alert>
        </div>
      )}

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="public-form-from">
              <Trans>From</Trans>
            </Label>
            <Input
              id="public-form-from"
              type="date"
              value={fromDate}
              onChange={(event) => {
                setFromDate(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="public-form-to">
              <Trans>To</Trans>
            </Label>
            <Input
              id="public-form-to"
              type="date"
              value={toDate}
              onChange={(event) => {
                setToDate(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Button variant="outline" size="sm" loading={isExporting} onClick={() => void onExport()}>
            <DownloadIcon className="mr-2 h-4 w-4" />
            <Trans>Export CSV</Trans>
          </Button>
        </div>

        <Table data-testid="public-form-responses">
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Submitted</Trans>
              </TableHead>
              <TableHead>
                <Trans>Submitter</Trans>
              </TableHead>
              <TableHead>
                <Trans>Email verified</Trans>
              </TableHead>
              <TableHead>
                <Trans>Status</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {responses?.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  <Trans>No responses yet</Trans>
                </TableCell>
              </TableRow>
            )}
            {responses?.data.map((response) => (
              <TableRow key={response.id}>
                <TableCell>{i18n.date(response.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</TableCell>
                <TableCell>
                  <div>{response.submitterName || response.submitterEmail}</div>
                  {response.submitterName && (
                    <div className="text-muted-foreground text-xs">{response.submitterEmail}</div>
                  )}
                </TableCell>
                <TableCell>{response.emailVerified ? <Trans>Yes</Trans> : <Trans>No</Trans>}</TableCell>
                <TableCell>
                  {response.status === 'DELETED' || response.documentId === null ? (
                    <Trans>Deleted</Trans>
                  ) : (
                    <Link
                      className="text-primary hover:underline"
                      to={`${formatDocumentsPath(team.url)}/${response.envelopeId}`}
                    >
                      {response.status === 'COMPLETED' && <Trans>Completed</Trans>}
                      {response.status === 'PENDING' && <Trans>Pending</Trans>}
                      {response.status === 'REJECTED' && <Trans>Rejected</Trans>}
                      {response.status === 'DRAFT' && <Trans>Draft</Trans>}
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {responses && responses.totalPages > 1 && (
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <Trans>Previous</Trans>
            </Button>
            <span className="text-muted-foreground text-sm">
              <Trans>
                Page {page} of {responses.totalPages}
              </Trans>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= responses.totalPages}
              onClick={() => setPage(page + 1)}
            >
              <Trans>Next</Trans>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

type PublicFormSettings = Awaited<ReturnType<typeof getPublicFormSettings>>;

const PublicFormSettingsDialog = ({ envelopeId, settings }: { envelopeId: string; settings: PublicFormSettings }) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(() => toFormValues(settings));

  const { mutateAsync: updateSettings, isPending } = trpc.publicForm.updateSettings.useMutation({
    onSuccess: async () => utils.publicForm.getSettings.invalidate({ envelopeId }),
  });

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    try {
      await updateSettings({
        envelopeId,
        data: {
          opensAt: values.opensAt ? new Date(values.opensAt) : null,
          closesAt: values.closesAt ? new Date(values.closesAt) : null,
          maxSubmissions: values.maxSubmissions ? Number(values.maxSubmissions) : null,
          introText: values.introText || null,
          thankYouMessage: values.thankYouMessage || null,
          redirectUrl: values.redirectUrl || null,
          requireVerifiedEmail: values.requireVerifiedEmail,
        },
      });

      toast({ title: t`Form settings saved` });
      setOpen(false);
    } catch (err) {
      toast({
        title: t`The settings were not saved`,
        description: AppError.parseError(err).message,
        variant: 'destructive',
      });
    }
  };

  const update = (patch: Partial<typeof values>) => setValues((previous) => ({ ...previous, ...patch }));

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);

        if (nextOpen) {
          setValues(toFormValues(settings));
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!settings.isEditable}>
          <Settings2Icon className="mr-2 h-4 w-4" />
          <Trans>Form settings</Trans>
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>Form settings</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Control when people can fill in this form and what they see.</Trans>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit}>
          <fieldset disabled={isPending} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="public-form-opens-at">
                  <Trans>Opens</Trans>
                </Label>
                <Input
                  id="public-form-opens-at"
                  type="datetime-local"
                  value={values.opensAt}
                  onChange={(event) => update({ opensAt: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="public-form-closes-at">
                  <Trans>Closes</Trans>
                </Label>
                <Input
                  id="public-form-closes-at"
                  type="datetime-local"
                  value={values.closesAt}
                  onChange={(event) => update({ closesAt: event.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="public-form-max">
                <Trans>Maximum number of responses</Trans>
              </Label>
              <Input
                id="public-form-max"
                type="number"
                min={1}
                placeholder={t`No limit`}
                value={values.maxSubmissions}
                onChange={(event) => update({ maxSubmissions: event.target.value })}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="public-form-intro">
                <Trans>Intro text</Trans>
              </Label>
              <Textarea
                id="public-form-intro"
                maxLength={2000}
                value={values.introText}
                onChange={(event) => update({ introText: event.target.value })}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="public-form-thank-you">
                <Trans>Thank-you message</Trans>
              </Label>
              <Textarea
                id="public-form-thank-you"
                maxLength={2000}
                value={values.thankYouMessage}
                onChange={(event) => update({ thankYouMessage: event.target.value })}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="public-form-redirect">
                <Trans>Redirect URL after submission</Trans>
              </Label>
              <Input
                id="public-form-redirect"
                type="url"
                placeholder="https://"
                value={values.redirectUrl}
                onChange={(event) => update({ redirectUrl: event.target.value })}
              />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-1">
                <Label htmlFor="public-form-verify">
                  <Trans>Verify the email address with a code</Trans>
                </Label>
                <p className="text-muted-foreground text-xs">
                  {settings.unverifiedBlocker ? (
                    <Trans>Required, because this template sends email to other people.</Trans>
                  ) : (
                    <Trans>Without it, nobody gets an email copy of the submitted document.</Trans>
                  )}
                </p>
              </div>
              <Switch
                id="public-form-verify"
                checked={values.requireVerifiedEmail}
                onCheckedChange={(checked) => update({ requireVerifiedEmail: checked })}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" loading={isPending}>
                <Trans>Save</Trans>
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const toLocalInput = (date: Date | null) => {
  if (!date) {
    return '';
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
};

const toFormValues = (settings: PublicFormSettings) => ({
  opensAt: toLocalInput(settings.form?.opensAt ?? null),
  closesAt: toLocalInput(settings.form?.closesAt ?? null),
  maxSubmissions: settings.form?.maxSubmissions ? String(settings.form.maxSubmissions) : '',
  introText: settings.form?.introText ?? '',
  thankYouMessage: settings.form?.thankYouMessage ?? '',
  redirectUrl: settings.form?.redirectUrl ?? '',
  requireVerifiedEmail: settings.form?.requireVerifiedEmail ?? true,
});

const addOneDay = (date: Date) => new Date(date.getTime() + 24 * 60 * 60 * 1000);
