import { useAnalytics } from '@documenso/lib/client-only/hooks/use-analytics';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TRecipientAccessAuth } from '@documenso/lib/types/document-auth';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@documenso/ui/primitives/form/form';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router';
import { z } from 'zod';

import { SIGNING_TOO_MANY_REQUESTS_MESSAGE } from '~/utils/toast-error-messages';

import { AccessAuth2FAForm } from './access-auth-2fa-form';
import { useDocumentSigningAuthContext } from './document-signing-auth-provider';

const ZRejectDocumentFormSchema = z.object({
  reason: z.string().max(500, msg`Reason must be less than 500 characters`),
});

type TRejectDocumentFormSchema = z.infer<typeof ZRejectDocumentFormSchema>;

export interface DocumentSigningRejectDialogProps {
  documentId: number;
  token: string;
  onRejected?: (reason: string) => void | Promise<void>;
  trigger?: React.ReactNode;
}

export function DocumentSigningRejectDialog({
  documentId,
  token,
  onRejected,
  trigger,
}: DocumentSigningRejectDialogProps) {
  const { t, i18n } = useLingui();
  const { toast } = useToast();
  const analytics = useAnalytics();
  const [searchParams] = useSearchParams();

  const [isOpen, setIsOpen] = useState(false);

  // Solid Ten Sign (AUD-14): a decline needs the emailed access code, as completion does.
  const authContext = useDocumentSigningAuthContext();
  const requiresAccessCode = authContext?.derivedRecipientAccessAuth.includes('TWO_FACTOR_AUTH') ?? false;
  const [pendingReason, setPendingReason] = useState<string | null>(null);
  const [accessCodeError, setAccessCodeError] = useState<string | null>(null);

  const { mutateAsync: rejectDocumentWithToken } = trpc.recipient.rejectDocumentWithToken.useMutation();

  const form = useForm<TRejectDocumentFormSchema>({
    resolver: zodResolver(ZRejectDocumentFormSchema),
    defaultValues: {
      reason: '',
    },
  });

  const onRejectDocument = async ({ reason }: TRejectDocumentFormSchema, accessAuthOptions?: TRecipientAccessAuth) => {
    if (requiresAccessCode && !accessAuthOptions) {
      setPendingReason(reason);

      return;
    }

    try {
      await rejectDocumentWithToken({
        documentId,
        token,
        reason,
        accessAuthOptions,
      });

      toast({
        title: t`Document rejected`,
        description: t`The document has been successfully rejected.`,
        duration: 5000,
      });

      setIsOpen(false);

      if (onRejected) {
        await onRejected(reason);
      } else {
        window.location.href = `/sign/${token}/rejected`;
      }
    } catch (err) {
      const errorCode = AppError.parseError(err).code;

      // Solid Ten Sign (AUD-14): a wrong or locked code is shown in the code form.
      if (accessAuthOptions && errorCode === AppErrorCode.TWO_FACTOR_AUTH_FAILED) {
        setAccessCodeError(t`Invalid verification code. Please try again.`);

        return;
      }

      if (accessAuthOptions && errorCode === AppErrorCode.TOO_MANY_REQUESTS) {
        setAccessCodeError(t`Too many wrong codes. Request a new code and try again.`);

        return;
      }

      analytics.captureException(err, {
        source: 'signing',
        location: 'reject_document',
        documentId,
      });

      // Solid Ten: a rate-limit refusal says so.
      const isRateLimited = errorCode === AppErrorCode.TOO_MANY_REQUESTS;

      toast({
        title: isRateLimited ? i18n._(SIGNING_TOO_MANY_REQUESTS_MESSAGE.title) : t`Error`,
        description: isRateLimited
          ? i18n._(SIGNING_TOO_MANY_REQUESTS_MESSAGE.description)
          : t`An error occurred while rejecting the document. Please try again.`,
        variant: 'destructive',
        duration: 5000,
      });
    }
  };

  useEffect(() => {
    if (searchParams?.get('reject') === 'true') {
      setIsOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      form.reset();
      setPendingReason(null);
      setAccessCodeError(null);
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <Trans>Reject Document</Trans>
          </Button>
        )}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Reject Document</Trans>
          </DialogTitle>

          <DialogDescription>
            <Trans>Are you sure you want to reject this document? This action cannot be undone.</Trans>
          </DialogDescription>
        </DialogHeader>

        {pendingReason !== null && (
          <AccessAuth2FAForm
            token={token}
            error={accessCodeError}
            onSubmit={async (accessAuthOptions) => onRejectDocument({ reason: pendingReason }, accessAuthOptions)}
          />
        )}

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(async (values) => onRejectDocument(values))}
            className={pendingReason !== null ? 'hidden' : 'space-y-4'}
          >
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={4}
                      placeholder={t`Please provide a reason for rejecting this document`}
                      disabled={form.formState.isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsOpen(false)}
                disabled={form.formState.isSubmitting}
              >
                <Trans>Cancel</Trans>
              </Button>

              <Button
                type="submit"
                variant="destructive"
                loading={form.formState.isSubmitting}
                disabled={!form.formState.isValid}
              >
                <Trans>Reject Document</Trans>
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
