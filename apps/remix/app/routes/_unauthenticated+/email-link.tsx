import { authClient } from '@documenso/auth/client';
import { AppError } from '@documenso/lib/errors/app-error';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Sign In`);
}

type Step = 'loading' | 'ready' | 'two-factor' | 'invalid';

/**
 * Landing page for an emailed sign-in link. The token arrives in the URL fragment, is taken out of
 * the address bar at once, and is only sent to the server when the person clicks the button.
 */
export default function EmailLinkPage() {
  const [token, setToken] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('loading');
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCodeWrong, setIsCodeWrong] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');

    window.history.replaceState(null, '', window.location.pathname);

    if (value && /^[a-f0-9]{64}$/.test(value)) {
      setToken(value);
      setStep('ready');
    } else {
      setStep('invalid');
    }
  }, []);

  const onSignIn = async () => {
    if (!token) {
      return;
    }

    setIsSubmitting(true);
    setIsCodeWrong(false);

    try {
      await authClient.emailLink.signIn({
        token,
        totpCode: step === 'two-factor' && !useBackupCode ? code.trim() : undefined,
        backupCode: step === 'two-factor' && useBackupCode ? code.trim() : undefined,
      });
    } catch (err) {
      const error = AppError.parseError(err);

      if (error.code === 'TWO_FACTOR_REQUIRED') {
        setStep('two-factor');
      } else if (error.code === 'INVALID_TWO_FACTOR_CODE') {
        setIsCodeWrong(true);
      } else {
        setStep('invalid');
      }

      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-screen max-w-lg px-4">
      <div className="z-10 rounded-xl border border-border bg-neutral-100 p-6 dark:bg-background">
        {step === 'loading' && (
          <p className="text-muted-foreground text-sm">
            <Trans>Checking your link...</Trans>
          </p>
        )}

        {step === 'ready' && (
          <>
            <h1 className="font-semibold text-2xl">
              <Trans>Finish signing in</Trans>
            </h1>

            <p className="mt-2 mb-6 text-muted-foreground text-sm">
              <Trans>Your link is good. Select the button to sign in on this device.</Trans>
            </p>

            <Button size="lg" className="w-full" loading={isSubmitting} onClick={onSignIn}>
              <Trans>Sign in</Trans>
            </Button>
          </>
        )}

        {step === 'two-factor' && (
          <>
            <h1 className="font-semibold text-2xl">
              <Trans>Enter your two-factor code</Trans>
            </h1>

            <p className="mt-2 mb-4 text-muted-foreground text-sm">
              {useBackupCode ? (
                <Trans>Enter one of the backup codes you saved when you set up two-factor authentication.</Trans>
              ) : (
                <Trans>This account uses two-factor authentication. Enter the code from your authenticator app.</Trans>
              )}
            </p>

            {/* Solid Ten Sign (O-F7): the code input has a label (screen readers and tests). */}
            <Label htmlFor="email-link-two-factor-code" className="mb-2 block">
              {useBackupCode ? <Trans>Backup code</Trans> : <Trans>Authenticator code</Trans>}
            </Label>
            <Input
              id="email-link-two-factor-code"
              inputMode={useBackupCode ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />

            {isCodeWrong && (
              <p className="mt-2 text-destructive text-sm">
                <Trans>That code did not work. Try again.</Trans>
              </p>
            )}

            <Button size="lg" className="mt-4 w-full" loading={isSubmitting} disabled={!code.trim()} onClick={onSignIn}>
              <Trans>Sign in</Trans>
            </Button>

            <Button
              type="button"
              variant="link"
              className="mt-2 w-full"
              onClick={() => {
                setUseBackupCode(!useBackupCode);
                setCode('');
                setIsCodeWrong(false);
              }}
            >
              {useBackupCode ? <Trans>Use an authenticator code</Trans> : <Trans>Use a backup code</Trans>}
            </Button>
          </>
        )}

        {step === 'invalid' && (
          <>
            <h1 className="font-semibold text-2xl">
              <Trans>This link does not work</Trans>
            </h1>

            <p className="mt-2 mb-6 text-muted-foreground text-sm">
              <Trans>A sign-in link works one time and expires after 15 minutes. Ask for a new one.</Trans>
            </p>

            <Button asChild size="lg" className="w-full">
              <Link to="/signin">
                <Trans>Get a new link</Trans>
              </Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
