import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getInPersonView } from '@documenso/lib/server-only/in-person/in-person-session';
import { trpc } from '@documenso/trpc/react';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent } from '@documenso/ui/primitives/card';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Trans, useLingui } from '@lingui/react/macro';
import { SigningStatus } from '@prisma/client';
import { useState } from 'react';
import { redirect, useLoaderData, useRevalidator } from 'react-router';
import { getOptionalLoaderContext } from 'server/utils/get-loader-session';
import { match } from 'ts-pattern';

import { InPersonPinForm } from '~/components/general/in-person/in-person-pin-form';

import type { Route } from './+types/in-person.$sessionId._index';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { session, user } = await getOptionalSession(request);

  if (!session || !user) {
    throw redirect('/signin');
  }

  const { requestMetadata } = getOptionalLoaderContext();

  try {
    const view = await getInPersonView({
      sessionId: params.sessionId,
      device: { host: user, authSessionId: session.id, requestMetadata },
    });

    return { view };
  } catch (err) {
    if (AppError.parseError(err).code === AppErrorCode.NOT_FOUND) {
      return { view: null };
    }

    throw err;
  }
}

const Shell = ({ children, testId }: { children: React.ReactNode; testId: string }) => (
  <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-12" data-testid={testId}>
    {children}
  </div>
);

const ErrorText = ({ error }: { error: string | null }) =>
  error ? (
    <p className="text-destructive text-sm" role="alert">
      {error}
    </p>
  ) : null;

/** A full reload drops every bit of client state from the previous screen. */
const reloadInPerson = (sessionId: string) => {
  window.location.href = `/in-person/${sessionId}`;
};

export default function InPersonPage() {
  const { view } = useLoaderData<typeof loader>();

  if (!view) {
    return (
      <Shell testId="in-person-ended">
        <h1 className="font-semibold text-2xl">
          <Trans>In-person signing has ended</Trans>
        </h1>
        <p className="mt-2 text-muted-foreground">
          <Trans>This in-person signing session is no longer running on this device.</Trans>
        </p>
        <Button className="mt-6 w-fit" onClick={() => (window.location.href = '/')}>
          <Trans>Go to Solid Ten Sign</Trans>
        </Button>
      </Shell>
    );
  }

  return match(view)
    .with({ phase: 'HOST' }, (v) => <HostScreen view={v} />)
    .with({ phase: 'HANDOVER' }, (v) => <HandoverScreen view={v} />)
    .with({ phase: 'SIGNER' }, (v) => <SignerScreen view={v} />)
    .with({ phase: 'HANDBACK' }, (v) => <HandbackScreen view={v} />)
    .exhaustive();
}

type View = NonNullable<Awaited<ReturnType<typeof loader>>['view']>;

const ExitSection = ({ sessionId }: { sessionId: string }) => {
  const { t } = useLingui();
  const [isOpen, setIsOpen] = useState(false);

  const { mutateAsync: exit } = trpc.inPerson.exit.useMutation();

  if (!isOpen) {
    return (
      <Button variant="ghost" size="sm" className="mt-8 w-fit" onClick={() => setIsOpen(true)}>
        <Trans>Exit in-person signing</Trans>
      </Button>
    );
  }

  return (
    <Card className="mt-8">
      <CardContent className="pt-6">
        <InPersonPinForm
          testId="in-person-exit-form"
          label={t`Host PIN`}
          submitLabel={t`Exit in-person signing`}
          onSubmit={async (pin) => {
            const { documentPath } = await exit({ sessionId, pin });

            window.location.href = documentPath;
          }}
        />
      </CardContent>
    </Card>
  );
};

const HostScreen = ({ view }: { view: Extract<View, { phase: 'HOST' }> }) => {
  const { t } = useLingui();
  const { revalidate } = useRevalidator();

  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: beginHandover, isPending } = trpc.inPerson.beginHandover.useMutation();

  const pendingSigners = view.signers.filter((signer) => signer.signingStatus === SigningStatus.NOT_SIGNED);

  const onHandOver = async (recipientId: number) => {
    setError(null);

    try {
      await beginHandover({ sessionId: view.sessionId, recipientId });
      await revalidate();
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
    }
  };

  return (
    <Shell testId="in-person-host">
      <p className="text-muted-foreground text-sm">
        <Trans>Signing in person</Trans>
      </p>
      <h1 className="mt-1 font-semibold text-2xl">{view.envelopeTitle}</h1>

      {!view.isEnvelopePending || pendingSigners.length === 0 ? (
        <p className="mt-4 text-muted-foreground">
          <Trans>Nobody else needs to sign on this device. Exit in-person signing to go back to the document.</Trans>
        </p>
      ) : (
        <p className="mt-4 text-muted-foreground">
          <Trans>Choose who signs next, then hand them the device.</Trans>
        </p>
      )}

      <div className="mt-6 space-y-3">
        {view.signers.map((signer) => (
          <Card key={signer.recipientId} data-testid={`in-person-signer-${signer.recipientId}`}>
            <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-medium">{signer.name || signer.email}</p>
                <p className="truncate text-muted-foreground text-sm">{signer.email}</p>
                {signer.blockMessage && signer.signingStatus === SigningStatus.NOT_SIGNED && (
                  <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-500">{signer.blockMessage}</p>
                )}
                {signer.requiresEmailCode && signer.signingStatus === SigningStatus.NOT_SIGNED && (
                  <p className="mt-1 text-muted-foreground text-xs">
                    <Trans>Needs an email code</Trans>
                  </p>
                )}
              </div>

              {match(signer.signingStatus)
                .with(SigningStatus.SIGNED, () => (
                  <Badge variant="default">
                    <Trans>Signed</Trans>
                  </Badge>
                ))
                .with(SigningStatus.REJECTED, () => (
                  <Badge variant="destructive">
                    <Trans>Declined</Trans>
                  </Badge>
                ))
                .otherwise(() =>
                  signer.isTheirTurn && !signer.blockReason ? (
                    <Button disabled={isPending} onClick={() => void onHandOver(signer.recipientId)}>
                      <Trans>Hand over to sign</Trans>
                    </Button>
                  ) : (
                    <Badge variant="secondary">
                      {signer.isTheirTurn ? <Trans>Cannot sign here</Trans> : <Trans>Waiting for their turn</Trans>}
                    </Badge>
                  ),
                )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-4">
        <ErrorText error={error} />
      </div>

      <ExitSection sessionId={view.sessionId} />
    </Shell>
  );
};

const StopTurnButton = ({ sessionId, label }: { sessionId: string; label: React.ReactNode }) => {
  const { mutateAsync: stopTurn, isPending } = trpc.inPerson.stopTurn.useMutation();

  return (
    <Button
      variant="ghost"
      className="w-fit"
      disabled={isPending}
      onClick={async () => {
        await stopTurn({ sessionId }).catch(() => null);
        reloadInPerson(sessionId);
      }}
    >
      {label}
    </Button>
  );
};

const HandoverScreen = ({ view }: { view: Extract<View, { phase: 'HANDOVER' }> }) => {
  const { t } = useLingui();
  const { revalidate } = useRevalidator();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const { mutateAsync: confirmSigner, isPending: isConfirming } = trpc.inPerson.confirmSigner.useMutation();
  const { mutateAsync: verifyEmailCode, isPending: isVerifying } = trpc.inPerson.verifyEmailCode.useMutation();
  const { mutateAsync: resendEmailCode, isPending: isResending } = trpc.inPerson.resendEmailCode.useMutation();

  const goToSigning = () => {
    window.location.href = `/in-person/${view.sessionId}/sign`;
  };

  const onConfirmName = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      const { needsEmailCode } = await confirmSigner({ sessionId: view.sessionId, name });

      if (needsEmailCode) {
        await revalidate();
        return;
      }

      goToSigning();
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
    }
  };

  const onVerifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await verifyEmailCode({ sessionId: view.sessionId, code });
      goToSigning();
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
    }
  };

  const onResend = async () => {
    setError(null);
    setInfo(null);

    try {
      await resendEmailCode({ sessionId: view.sessionId });
      setInfo(t`We sent a new code.`);
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
    }
  };

  return (
    <Shell testId="in-person-handover">
      <p className="text-muted-foreground text-sm">{view.envelopeTitle}</p>
      <h1 className="mt-1 font-semibold text-3xl">
        <Trans>Hand the device to {view.recipientName}</Trans>
      </h1>

      <Card className="mt-8">
        <CardContent className="pt-6">
          {!view.isNameConfirmed ? (
            <form onSubmit={onConfirmName} className="space-y-4">
              <p className="text-sm">
                <Trans>
                  {view.recipientName}, please confirm who you are. Type your full name as it appears on the document.
                </Trans>
              </p>

              <div className="space-y-1.5">
                <Label htmlFor="in-person-name">
                  <Trans>Your full name</Trans>
                </Label>
                <Input
                  id="in-person-name"
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <ErrorText error={error} />

              <Button type="submit" className="w-full" loading={isConfirming} disabled={name.trim().length < 2}>
                <Trans>Confirm and continue</Trans>
              </Button>
            </form>
          ) : (
            <form onSubmit={onVerifyCode} className="space-y-4">
              <p className="text-sm">
                {view.emailCodeSentTo ? (
                  <Trans>
                    We sent a code to {view.emailCodeSentTo}. Open the email on your own phone and enter the code.
                  </Trans>
                ) : (
                  <Trans>Send a code to your email to continue.</Trans>
                )}
              </p>

              <div className="space-y-1.5">
                <Label htmlFor="in-person-code">
                  <Trans>Email code</Trans>
                </Label>
                <Input
                  id="in-person-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
              </div>

              <ErrorText error={error} />
              {info && <p className="text-muted-foreground text-sm">{info}</p>}

              <Button type="submit" className="w-full" loading={isVerifying} disabled={code.length < 6}>
                <Trans>Verify and continue</Trans>
              </Button>

              <Button type="button" variant="ghost" className="w-full" loading={isResending} onClick={onResend}>
                <Trans>Send a new code</Trans>
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <div className="mt-6">
        <StopTurnButton sessionId={view.sessionId} label={<Trans>This is not me. Hand the device back.</Trans>} />
      </div>
    </Shell>
  );
};

const SignerScreen = ({ view }: { view: Extract<View, { phase: 'SIGNER' }> }) => {
  return (
    <Shell testId="in-person-signer">
      <p className="text-muted-foreground text-sm">{view.envelopeTitle}</p>
      <h1 className="mt-1 font-semibold text-2xl">
        <Trans>{view.recipientName} is signing</Trans>
      </h1>

      <div className="mt-6 flex flex-col gap-3">
        <Button className="w-fit" onClick={() => (window.location.href = `/in-person/${view.sessionId}/sign`)}>
          <Trans>Continue signing</Trans>
        </Button>

        <StopTurnButton sessionId={view.sessionId} label={<Trans>Stop and hand the device back</Trans>} />
      </div>
    </Shell>
  );
};

const HandbackScreen = ({ view }: { view: Extract<View, { phase: 'HANDBACK' }> }) => {
  const { t } = useLingui();

  const { mutateAsync: unlock } = trpc.inPerson.unlock.useMutation();

  const recipientName = view.recipientName ?? '';

  return (
    <Shell testId="in-person-handback">
      <p className="text-muted-foreground text-sm">{view.envelopeTitle}</p>

      {match(view.outcome)
        .with('SIGNED', () => (
          <p className="mt-1 text-green-700 dark:text-green-500">
            <Trans>Thank you, {recipientName}. Your part is done.</Trans>
          </p>
        ))
        .with('REJECTED', () => (
          <p className="mt-1 text-muted-foreground">
            <Trans>{recipientName} declined to sign.</Trans>
          </p>
        ))
        .with('REASSIGNED', () => (
          <p className="mt-1 text-muted-foreground">
            <Trans>This signing request was passed to someone else.</Trans>
          </p>
        ))
        .otherwise(() => null)}

      <h1 className="mt-2 font-semibold text-3xl">
        <Trans>Hand the device back to {view.hostName}</Trans>
      </h1>

      <Card className="mt-8">
        <CardContent className="pt-6">
          <InPersonPinForm
            testId="in-person-unlock-form"
            label={t`Host PIN`}
            submitLabel={t`Unlock`}
            onSubmit={async (pin) => {
              await unlock({ sessionId: view.sessionId, pin });
              reloadInPerson(view.sessionId);
            }}
          />
        </CardContent>
      </Card>

      <ExitSection sessionId={view.sessionId} />
    </Shell>
  );
};
