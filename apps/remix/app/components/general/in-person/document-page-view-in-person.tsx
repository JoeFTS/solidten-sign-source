import { AppError } from '@documenso/lib/errors/app-error';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { useState } from 'react';

export type DocumentPageViewInPersonProps = {
  envelope: Pick<TEnvelope, 'id' | 'status' | 'internalVersion'>;
};

/**
 * "Sign in person" on the document page: start hosting signers on this device,
 * or end a session left running on another device.
 */
export const DocumentPageViewInPerson = ({ envelope }: DocumentPageViewInPersonProps) => {
  const { t, i18n } = useLingui();
  const { toast } = useToast();

  const isEligible = envelope.status === DocumentStatus.PENDING && envelope.internalVersion === 2;

  const { data, refetch } = trpc.inPerson.getOptions.useQuery({ envelopeId: envelope.id }, { enabled: isEligible });

  const { mutateAsync: endForEnvelope, isPending: isEnding } = trpc.inPerson.endForEnvelope.useMutation();

  const [isDialogOpen, setIsDialogOpen] = useState(false);

  if (!isEligible || !data || (!data.isAvailable && data.activeSessions.length === 0)) {
    return null;
  }

  const onEnd = async () => {
    try {
      await endForEnvelope({ envelopeId: envelope.id });
      await refetch();

      toast({ title: t`In-person signing ended` });
    } catch (err) {
      toast({
        title: t`Something went wrong`,
        description: AppError.parseError(err).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <section
      className="flex flex-col rounded-xl border border-border bg-widget dark:bg-background"
      data-testid="document-in-person"
    >
      <div className="flex flex-row items-center justify-between gap-2 px-4 py-3">
        <h1 className="font-medium text-foreground">
          <Trans>Sign in person</Trans>
        </h1>

        {data.isAvailable && (
          <Button size="sm" variant="outline" onClick={() => setIsDialogOpen(true)}>
            <Trans>Sign in person</Trans>
          </Button>
        )}
      </div>

      <p className="border-t px-4 py-3 text-muted-foreground text-sm">
        <Trans>Signers who are with you can sign on this device, one after the other.</Trans>
      </p>

      {data.activeSessions.length > 0 && (
        <div className="space-y-2 border-t px-4 py-3 text-sm">
          {data.activeSessions.map((session) => (
            <p key={session.id} className="text-muted-foreground">
              <Trans>
                Running on {session.hostName}'s device since{' '}
                {DateTime.fromJSDate(session.startedAt).setLocale(i18n.locale).toLocaleString(DateTime.DATETIME_SHORT)}
              </Trans>
            </p>
          ))}

          <Button size="sm" variant="destructive" loading={isEnding} onClick={onEnd}>
            <Trans>End in-person signing</Trans>
          </Button>
        </div>
      )}

      <StartInPersonDialog
        envelopeId={envelope.id}
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        signers={data.signers}
      />
    </section>
  );
};

type StartInPersonDialogProps = {
  envelopeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signers: {
    recipientId: number;
    name: string;
    email: string;
    isTheirTurn: boolean;
    blockMessage: string | null;
  }[];
};

const StartInPersonDialog = ({ envelopeId, open, onOpenChange, signers }: StartInPersonDialogProps) => {
  const { t } = useLingui();

  const [emailCodeRecipientIds, setEmailCodeRecipientIds] = useState<number[]>([]);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: start, isPending } = trpc.inPerson.start.useMutation();

  const isPinValid = /^\d{4,8}$/.test(pin) && pin === pinConfirm;

  const onStart = async () => {
    setError(null);

    try {
      const { sessionId } = await start({ envelopeId, pin, emailCodeRecipientIds });

      // A full page load: from here this browser only shows the in-person screens.
      window.location.href = `/in-person/${sessionId}`;
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !isPending && onOpenChange(value)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Sign in person</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Hand this device to each signer in turn. They confirm their name and sign on the normal signing page. No
              signing emails are sent to them. While in-person signing runs, this browser cannot open your account until
              you enter your PIN.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="font-medium text-sm">
            <Trans>Signers</Trans>
          </p>

          {signers.map((signer) => (
            <div key={signer.recipientId} className="rounded-md border p-3 text-sm">
              <p className="font-medium">{signer.name || signer.email}</p>
              <p className="text-muted-foreground">{signer.email}</p>

              {signer.blockMessage ? (
                <p className="mt-1 text-yellow-700 dark:text-yellow-500">{signer.blockMessage}</p>
              ) : (
                <div className="mt-2 flex items-center gap-2">
                  <Checkbox
                    id={`in-person-email-code-${signer.recipientId}`}
                    checked={emailCodeRecipientIds.includes(signer.recipientId)}
                    onCheckedChange={(checked) =>
                      setEmailCodeRecipientIds((ids) =>
                        checked ? [...ids, signer.recipientId] : ids.filter((id) => id !== signer.recipientId),
                      )
                    }
                  />
                  <Label htmlFor={`in-person-email-code-${signer.recipientId}`} className="font-normal">
                    <Trans>Ask for a code sent to their email</Trans>
                  </Label>
                </div>
              )}

              {!signer.isTheirTurn && (
                <p className="mt-1 text-muted-foreground text-xs">
                  <Trans>Not their turn yet. They can sign after the signers before them.</Trans>
                </p>
              )}
            </div>
          ))}

          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="in-person-pin">
                <Trans>Your PIN (4 to 8 digits)</Trans>
              </Label>
              <Input
                id="in-person-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={8}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="in-person-pin-confirm">
                <Trans>Repeat the PIN</Trans>
              </Label>
              <Input
                id="in-person-pin-confirm"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={8}
                value={pinConfirm}
                onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, ''))}
              />
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            <Trans>You need the PIN to take the device back after each signer and to leave in-person signing.</Trans>
          </p>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" disabled={isPending} onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button loading={isPending} disabled={!isPinValid} onClick={onStart}>
            <Trans>Start in-person signing</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
