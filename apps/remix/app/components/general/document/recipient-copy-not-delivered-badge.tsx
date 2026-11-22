import { AppError } from '@documenso/lib/errors/app-error';
import { trpc as trpcReact } from '@documenso/trpc/react';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { PopoverHover } from '@documenso/ui/primitives/popover';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { useRef } from 'react';

export type RecipientCopyNotDeliveredBadgeProps = {
  envelopeId: string;
  recipientId: number;
};

/**
 * Solid Ten Sign: the signed copy could not be emailed to this recipient of a completed document.
 * Shows "Copy not delivered" with "Resend signed copy". The badge goes away once the mail server
 * accepted the resent copy (the job clears deliveryFailedAt); a new give-up brings it back.
 */
export const RecipientCopyNotDeliveredBadge = ({ envelopeId, recipientId }: RecipientCopyNotDeliveredBadgeProps) => {
  const { t } = useLingui();
  const { toast } = useToast();

  const { mutateAsync: resendSignedCopy, isPending, isSuccess } = trpcReact.lifecycle.resendSignedCopy.useMutation();

  // Solid Ten Sign (G1-D1): one request per click, also on a double click faster than a render.
  const isSendingRef = useRef(false);

  const onResend = async () => {
    if (isSendingRef.current) {
      return;
    }

    isSendingRef.current = true;

    try {
      await resendSignedCopy({ envelopeId, recipientId });

      toast({
        title: t`Signed copy on its way`,
        description: t`The signed copy will be emailed again. This badge goes away once it is sent.`,
        duration: 5000,
      });
    } catch (err) {
      const error = AppError.parseError(err);

      toast({
        title: t`Could not send`,
        description: error.userMessage ?? t`The email could not be sent. Try again later.`,
        variant: 'destructive',
      });

      // A refusal may be tried again (for example after the in-progress wait).
      isSendingRef.current = false;
    }
  };

  return (
    <PopoverHover
      trigger={
        <Badge variant="destructive" data-testid={`recipient-copy-not-delivered-${recipientId}`}>
          <AlertTriangle className="mr-1 h-3 w-3" />
          <Trans>Copy not delivered</Trans>
        </Badge>
      }
    >
      <p className="text-muted-foreground text-sm">
        <Trans>The signed copy could not be emailed. Check the email address, then send it again.</Trans>
      </p>

      <p className="mt-1 text-muted-foreground text-xs">
        <Trans>You can also download it and send it another way.</Trans>
      </p>

      <Button
        className="mt-2"
        size="sm"
        type="button"
        loading={isPending}
        disabled={isPending || isSuccess}
        onClick={onResend}
        data-testid={`recipient-resend-signed-copy-${recipientId}`}
      >
        <Trans>Resend signed copy</Trans>
      </Button>
    </PopoverHover>
  );
};
