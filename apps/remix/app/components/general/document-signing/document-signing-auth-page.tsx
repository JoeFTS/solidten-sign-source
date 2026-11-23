import { authClient } from '@documenso/auth/client';
import { useIsFramed } from '@documenso/lib/client-only/hooks/use-is-framed';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { formatPath } from '@documenso/lib/constants/app';
import { isSignupAvailable } from '@documenso/lib/utils/signup-availability';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { EmbedPopupAuth } from '~/components/embed/embed-popup-auth';

export type DocumentSigningAuthPageViewProps = {
  email?: string;
  emailHasAccount?: boolean;
};

export const DocumentSigningAuthPageView = ({ email, emailHasAccount }: DocumentSigningAuthPageViewProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();

  const isFramed = useIsFramed();

  const { sessionData } = useOptionalSession();

  const [isSigningOut, setIsSigningOut] = useState(false);

  // Solid Ten Sign (F-6): no "Sign up" where nobody can create an account; sign in instead.
  const isSignUp = !emailHasAccount && isSignupAvailable();

  const mismatchedUserEmail =
    sessionData?.user && email && sessionData.user.email !== email ? sessionData.user.email : undefined;

  const handleChangeAccount = async (email?: string) => {
    try {
      setIsSigningOut(true);

      let redirectPath = formatPath('/signin');

      if (email) {
        redirectPath = isSignUp ? formatPath(`/signup#email=${email}`) : formatPath(`/signin#email=${email}`);
      }

      await authClient.signOut({
        redirectPath,
      });
    } catch {
      toast({
        title: _(msg`Something went wrong`),
        description: _(msg`We were unable to log you out at this time.`),
        duration: 10000,
        variant: 'destructive',
      });
    }

    setIsSigningOut(false);
  };

  return (
    <div className="mx-auto flex h-[70vh] w-full max-w-md flex-col items-center justify-center">
      <div className="w-full">
        <h1 className="font-semibold text-3xl">
          <Trans>Authentication required</Trans>
        </h1>

        <p className="mt-2 text-muted-foreground text-sm">
          {email ? (
            <Trans>
              You need to be logged in as <strong>{email}</strong> to view this page.
            </Trans>
          ) : (
            <Trans>You need to be logged in to view this page.</Trans>
          )}
        </p>

        {isFramed ? (
          <EmbedPopupAuth
            className="mt-4"
            email={email || undefined}
            signedInAs={mismatchedUserEmail}
            onSuccess={() => window.location.reload()}
          />
        ) : (
          <Button
            className="mt-4 w-full"
            type="submit"
            onClick={async () => handleChangeAccount(email)}
            loading={isSigningOut}
          >
            {isSignUp ? <Trans>Sign up</Trans> : <Trans>Login</Trans>}
          </Button>
        )}

        {!isFramed && !emailHasAccount && !isSignUp && (
          <div className="mt-3 text-muted-foreground text-xs" data-testid="signing-auth-no-signup">
            <Trans>If you do not have an account here, ask the person who sent you the document.</Trans>
          </div>
        )}
      </div>
    </div>
  );
};
