import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { EnvelopeRenderProvider } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { viewedDocument } from '@documenso/lib/server-only/document/viewed-document';
import { getEnvelopeForRecipientSigning } from '@documenso/lib/server-only/envelope/get-envelope-for-recipient-signing';
import { getInPersonSigningToken } from '@documenso/lib/server-only/in-person/in-person-session';
import { hideRecipientTokensIn } from '@documenso/lib/server-only/in-person/in-person-turn-token';
import { extractDocumentAuthMethods } from '@documenso/lib/utils/document-auth';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { redirect } from 'react-router';
import { getOptionalLoaderContext } from 'server/utils/get-loader-session';

import { EmbedSigningProvider } from '~/components/embed/embed-signing-context';
import { DocumentSigningAuthProvider } from '~/components/general/document-signing/document-signing-auth-provider';
import { DocumentSigningPageViewV2 } from '~/components/general/document-signing/document-signing-page-view-v2';
import { EnvelopeSigningProvider } from '~/components/general/document-signing/envelope-signing-provider';
import { RecipientBranding } from '~/components/general/recipient-branding';
import { useCspNonce } from '~/utils/nonce';
import { superLoaderJson, useSuperLoaderData } from '~/utils/super-json-loader';

import type { Route } from './+types/in-person.$sessionId.sign';

/**
 * The normal signing page for the signer whose turn it is, on the host's device.
 *
 * The link token comes from the server-side session and never reaches the
 * device: the page gets a turn credential that only this sign-in can use, only
 * until the turn ends. The host's sign-in is ignored for the signer: no saved
 * name or signature, no account checks.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const { sessionId } = params;

  const { session, user } = await getOptionalSession(request);

  if (!session || !user) {
    throw redirect('/signin');
  }

  const { requestMetadata } = getOptionalLoaderContext();

  // Not a redirect: the signing page revalidates right after it completes, and a
  // redirect would race the full page load that clears the signer's state.
  const turnIsOver = superLoaderJson({ sessionId, isTurnOver: true as const });

  const tokens = await getInPersonSigningToken({
    sessionId,
    device: { host: user, authSessionId: session.id, requestMetadata },
  }).catch((err) => {
    if (AppError.parseError(err).code === AppErrorCode.NOT_FOUND) {
      return null;
    }

    throw err;
  });

  if (!tokens) {
    return turnIsOver;
  }

  // The link token stays on the server. The page gets the turn credential instead.
  const { token, turnToken } = tokens;

  const envelopeForSigning = await getEnvelopeForRecipientSigning({ token, userId: undefined }).catch(() => null);

  if (!envelopeForSigning) {
    return turnIsOver;
  }

  const { envelope, recipient, isCompleted, isRejected, isExpired, isRecipientsTurn } = envelopeForSigning;

  if (!isRecipientsTurn || isCompleted || isRejected || isExpired || envelope.deletedAt) {
    return turnIsOver;
  }

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  await viewedDocument({
    token,
    requestMetadata,
    recipientAccessAuth: derivedRecipientAccessAuth,
  }).catch(() => null);

  const branding = await loadRecipientBrandingByTeamId({ teamId: envelope.teamId });

  return superLoaderJson({
    sessionId,
    isTurnOver: false as const,
    envelopeForSigning: hideRecipientTokensIn(envelopeForSigning, new Map([[token, turnToken]])),
    branding,
  });
}

const noop = () => {};

export default function InPersonSigningPage() {
  const data = useSuperLoaderData<typeof loader>();

  if (data.isTurnOver) {
    return <TurnIsOver sessionId={data.sessionId} />;
  }

  return <InPersonSigning {...data} />;
}

const TurnIsOver = ({ sessionId }: { sessionId: string }) => {
  useEffect(() => {
    window.location.replace(`/in-person/${sessionId}`);
  }, [sessionId]);

  return (
    <div
      className="flex min-h-screen items-center justify-center text-muted-foreground"
      data-testid="in-person-turn-over"
    >
      <Trans>One moment…</Trans>
    </div>
  );
};

const InPersonSigning = ({
  sessionId,
  envelopeForSigning,
  branding,
}: Extract<ReturnType<typeof useSuperLoaderData<typeof loader>>, { isTurnOver: false }>) => {
  const cspNonce = useCspNonce();

  const { envelope, recipient } = envelopeForSigning;

  const { mutateAsync: stopTurn, isPending } = trpc.inPerson.stopTurn.useMutation();

  // Solid Ten Sign (RT2-L3): the moment the signer acts, the signing page goes away. Unmounting
  // it stops every query that still polls with the (now cleared) turn credential, and the
  // next person never sees the previous signer's page. A full page load then clears every
  // bit of signing state.
  const [isDone, setIsDone] = useState(false);

  // The complete and decline requests end the turn on the server, so a refetch of this page's
  // queries afterwards would only fail (and retry for seconds). Skip the usual
  // invalidate-after-mutation for those two on this page; it is left at once anyway.
  const utils = trpc.useUtils();

  useState(() => {
    const meta = { doNotInvalidateQueryOnMutation: true };

    utils.recipient.completeDocumentWithToken.setMutationDefaults({ meta });
    utils.recipient.rejectDocumentWithToken.setMutationDefaults({ meta });

    return true;
  });

  const backToSession = () => {
    setIsDone(true);
  };

  if (isDone) {
    return <TurnIsOver sessionId={sessionId} />;
  }

  return (
    <>
      <RecipientBranding branding={branding} cspNonce={cspNonce} />

      <div
        className="flex items-center justify-between gap-2 bg-documenso-700 px-4 py-2 text-sm text-white"
        data-testid="in-person-signing-bar"
      >
        <span className="truncate">
          <Trans>Signing in person as {recipient.name || recipient.email}</Trans>
        </span>

        <Button
          size="sm"
          variant="secondary"
          disabled={isPending}
          onClick={async () => {
            await stopTurn({ sessionId }).catch(() => null);
            backToSession();
          }}
        >
          <Trans>Stop and hand back</Trans>
        </Button>
      </div>

      <EmbedSigningProvider
        allowDocumentRejection
        allowDownloadPDF
        hidePoweredBy
        isNameLocked={false}
        isEmailLocked
        onDocumentCompleted={backToSession}
        onDocumentRejected={backToSession}
        onDocumentError={noop}
        onDocumentReady={noop}
        onFieldSigned={noop}
        onFieldUnsigned={noop}
        onSignatureChanged={noop}
      >
        <EnvelopeSigningProvider
          envelopeData={envelopeForSigning}
          email={recipient.email}
          fullName={recipient.name}
          signature={undefined}
        >
          <DocumentSigningAuthProvider documentAuthOptions={envelope.authOptions} recipient={recipient} user={null}>
            <EnvelopeRenderProvider
              version="current"
              envelope={envelope}
              envelopeItems={envelope.envelopeItems}
              contents={envelope.contents}
              token={recipient.token}
            >
              <DocumentSigningPageViewV2 />
            </EnvelopeRenderProvider>
          </DocumentSigningAuthProvider>
        </EnvelopeSigningProvider>
      </EmbedSigningProvider>
    </>
  );
};
