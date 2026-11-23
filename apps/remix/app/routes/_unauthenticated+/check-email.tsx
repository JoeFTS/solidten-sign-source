import { isPasswordSigninAvailable } from '@documenso/lib/utils/password-signin-availability';
import { Button } from '@documenso/ui/primitives/button';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Link, redirect } from 'react-router';
import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Forgot password`);
}

// Solid Ten Sign (O-F6): this page only follows a password reset request. With password sign-in
// off there is none, so the page is a dead end that talks about a password.
export function loader() {
  if (!isPasswordSigninAvailable()) {
    throw redirect('/signin');
  }

  return null;
}

export default function ForgotPasswordPage() {
  return (
    <div className="w-screen max-w-lg px-4">
      <div className="w-full">
        <h1 className="font-semibold text-4xl">
          <Trans>Email sent!</Trans>
        </h1>

        <p className="mt-2 mb-4 text-muted-foreground text-sm">
          <Trans>
            A password reset email has been sent, if you have an account you should see it in your inbox shortly.
          </Trans>
        </p>

        <Button asChild>
          <Link to="/signin">
            <Trans>Return to sign in</Trans>
          </Link>
        </Button>
      </div>
    </div>
  );
}
