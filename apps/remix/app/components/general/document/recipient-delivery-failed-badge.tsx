import { AppError } from '@documenso/lib/errors/app-error';
import { trpc as trpcReact } from '@documenso/trpc/react';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { PopoverHover } from '@documenso/ui/primitives/popover';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { MailWarningIcon } from 'lucide-react';

export type RecipientDeliveryFailedBadgeProps = {
  envelopeId: string;
  recipientId: number;
  onResent: () => Promise<void> | void;
};

/**
 * Solid Ten: the signing request to this recipient could not be delivered after every retry.
 * Shows a "Not delivered" badge with a resend action for this one recipient.
 */
export const RecipientDeliveryFailedBadge = ({
  envelopeId,
  recipientId,
  onResent,
}: RecipientDeliveryFailedBadgeProps) => {
  const { t } = useLingui();
  const { toast } = useToast();

  const trpcUtils = trpcReact.useUtils();

  const { mutateAsync: redistributeEnvelope, isPending } = trpcReact.envelope.redistribute.useMutation();

  const onResend = async () => {
    try {
      await redistributeEnvelope({ envelopeId, recipients: [recipientId] });

      toast({
        title: t`Signing request sent`,
        description: t`The signing request was sent again.`,
        duration: 5000,
      });

      // The document page reads the envelope from this query, not from the route loader.
      await trpcUtils.envelope.get.invalidate({ envelopeId });
      await onResent();
    } catch (err) {
      const error = AppError.parseError(err);

      toast({
        title: t`Could not send`,
        description: error.userMessage ?? t`The email could not be sent. Try again later.`,
        variant: 'destructive',
      });
    }
  };

  return (
    <PopoverHover
      trigger={
        <Badge variant="destructive" data-testid={`recipient-not-delivered-${recipientId}`}>
          <MailWarningIcon className="mr-1 h-3 w-3" />
          <Trans>Not delivered</Trans>
        </Badge>
      }
    >
      <p className="text-sm">
        <Trans>The signing request could not be delivered.</Trans>
      </p>

      <p className="mt-1 text-muted-foreground text-xs">
        <Trans>Check the email address, then send it again. You can also copy the signing link.</Trans>
      </p>

      <Button
        className="mt-2"
        size="sm"
        type="button"
        loading={isPending}
        onClick={onResend}
        data-testid={`recipient-resend-${recipientId}`}
      >
        <Trans>Resend</Trans>
      </Button>
    </PopoverHover>
  );
};
