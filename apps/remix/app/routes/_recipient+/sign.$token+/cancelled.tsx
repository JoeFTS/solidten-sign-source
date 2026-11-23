import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { BanIcon } from 'lucide-react';
import { Link } from 'react-router';

import { DocumentSigningAuthPageView } from '~/components/general/document-signing/document-signing-auth-page';
import { RecipientBranding } from '~/components/general/recipient-branding';
import { useCspNonce } from '~/utils/nonce';

import type { Route } from './+types/cancelled';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  const document = await getDocumentAndSenderByToken({
    token,
    requireAccessAuth: false,
  }).catch(() => null);

  if (!document || document.status !== DocumentStatus.CANCELLED) {
    throw new Response('Not Found', { status: 404 });
  }

  const branding = await loadRecipientBrandingByTeamId({ teamId: document.teamId });

  const title = document.title;

  const recipient = await getRecipientByToken({ token }).catch(() => null);

  if (!recipient) {
    throw new Response('Not Found', { status: 404 });
  }

  const isDocumentAccessValid = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: document.authOptions,
    recipient,
    userId: user?.id,
  });

  const recipientEmail = recipient.email;

  if (isDocumentAccessValid) {
    return {
      isDocumentAccessValid: true,
      recipientEmail,
      title,
      branding,
    };
  }

  return {
    isDocumentAccessValid: false,
    recipientEmail,
    branding,
  };
}

/**
 * Solid Ten: shown instead of the signing page once the sender cancelled the document.
 */
export default function CancelledSigningPage({ loaderData }: Route.ComponentProps) {
  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;
  const cspNonce = useCspNonce();

  const { isDocumentAccessValid, recipientEmail, title, branding } = loaderData;

  if (!isDocumentAccessValid) {
    return (
      <>
        <RecipientBranding branding={branding} cspNonce={cspNonce} />
        <DocumentSigningAuthPageView email={recipientEmail} />
      </>
    );
  }

  return (
    <>
      <RecipientBranding branding={branding} cspNonce={cspNonce} />
      <div className="flex flex-col items-center pt-24 lg:pt-36 xl:pt-44">
        <Badge variant="neutral" size="default" title={title} className="mb-6 rounded-xl border bg-transparent">
          {/* Solid Ten Sign (F-7): cut at the end, and only when the title does not fit. */}
          <span className="block max-w-[10rem] truncate md:max-w-[20rem]">{title ?? ''}</span>
        </Badge>

        <div className="flex flex-col items-center">
          <div className="flex items-center gap-x-4">
            <BanIcon className="h-10 w-10 text-destructive" />

            <h2 className="max-w-[35ch] text-center font-semibold text-2xl leading-normal md:text-3xl lg:text-4xl">
              <Trans>This document was canceled</Trans>
            </h2>
          </div>

          <p className="mt-6 max-w-[60ch] text-center text-muted-foreground text-sm">
            <Trans>
              The sender canceled this document, so it can no longer be signed. Contact the sender if you think this is
              a mistake.
            </Trans>
          </p>

          {user && (
            <Button className="mt-6" asChild>
              <Link to={`/`}>
                <Trans>Return Home</Trans>
              </Link>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
