import { AppError } from '@documenso/lib/errors/app-error';
import type { PublicFormForVisitor } from '@documenso/lib/server-only/public-form/get-public-form-for-visitor';
import { env } from '@documenso/lib/utils/env';
import { PUBLIC_FORM_VERIFIED_PROOF_MAX_AGE_MS } from '@documenso/lib/utils/public-form';
import { zEmail } from '@documenso/lib/utils/zod';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent } from '@documenso/ui/primitives/card';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Trans, useLingui } from '@lingui/react/macro';
import type { TurnstileInstance } from '@marsidev/react-turnstile';
import { Turnstile } from '@marsidev/react-turnstile';
import { MailCheckIcon } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type PublicFormSubmissionPayload = {
  openedToken?: string;
  verifiedProof?: string;
  honeypot?: string;
  captchaToken?: string;
};

type PublicFormContextValue = {
  form: PublicFormForVisitor;
  getSubmissionPayload: () => Promise<PublicFormSubmissionPayload>;
  /**
   * Forget the verified email after the proof was used or refused. With keepOnScreen the page
   * stays as it is (the visitor is being sent on); only the stored proof goes.
   */
  clearVerification: (options?: { keepOnScreen?: boolean }) => void;
};

/**
 * Solid Ten Sign (RT4-M3): a verified visitor who reloads keeps their unused proof, so they do
 * not need a new code. Kept in sessionStorage (this tab only, never in the URL), and dropped
 * when it is used, refused or too old.
 */
const getStoredProofKey = (formId: string) => `st-public-form-proof:${formId}`;

const readStoredProof = (formId: string): { email: string; proof: string } | null => {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(getStoredProofKey(formId)) ?? 'null');

    if (!parsed || typeof parsed.email !== 'string' || typeof parsed.proof !== 'string') {
      return null;
    }

    const issuedAt = Number(parsed.proof.split('.')[0]);

    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > PUBLIC_FORM_VERIFIED_PROOF_MAX_AGE_MS) {
      return null;
    }

    return { email: parsed.email, proof: parsed.proof };
  } catch {
    return null;
  }
};

const writeStoredProof = (formId: string, value: { email: string; proof: string } | null) => {
  try {
    if (value) {
      window.sessionStorage.setItem(getStoredProofKey(formId), JSON.stringify(value));
    } else {
      window.sessionStorage.removeItem(getStoredProofKey(formId));
    }
  } catch {
    // Storage can be blocked; the visitor then verifies again after a reload.
  }
};

const PublicFormContext = createContext<PublicFormContextValue | null>(null);

/**
 * Null outside a public form, so direct links that are not forms behave as before.
 */
export const usePublicForm = () => useContext(PublicFormContext);

export type PublicFormProviderProps = {
  form: PublicFormForVisitor | null;
  title: string;
  /**
   * Gets the verified email address, or null when the form does not verify one.
   */
  children: (props: { verifiedEmail: string | null }) => ReactNode;
};

/**
 * Wraps the signing page of a public form. Shows why a closed form is closed, asks for and
 * checks the email code before the document is shown, and adds the anti-abuse values to the
 * submission. The server checks every one of them again.
 */
export const PublicFormProvider = ({ form, title, children }: PublicFormProviderProps) => {
  if (!form) {
    return <>{children({ verifiedEmail: null })}</>;
  }

  return (
    <PublicFormProviderInner form={form} title={title}>
      {children}
    </PublicFormProviderInner>
  );
};

const PublicFormProviderInner = ({
  form,
  title,
  children,
}: Omit<PublicFormProviderProps, 'form'> & { form: PublicFormForVisitor }) => {
  const turnstileSiteKey = env('NEXT_PUBLIC_TURNSTILE_SITE_KEY');
  const turnstileRef = useRef<TurnstileInstance>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);

  const [verified, setVerifiedState] = useState<{ email: string; proof: string } | null>(null);

  // Read after hydration, so the server and the first client render agree.
  useEffect(() => {
    const stored = readStoredProof(form.formId);

    if (stored) {
      setVerifiedState(stored);
    } else {
      writeStoredProof(form.formId, null);
    }
  }, [form.formId]);

  const setVerified = useCallback(
    (value: { email: string; proof: string } | null) => {
      writeStoredProof(form.formId, value);
      setVerifiedState(value);
    },
    [form.formId],
  );

  const clearVerification = useCallback(
    (options?: { keepOnScreen?: boolean }) => {
      if (options?.keepOnScreen) {
        writeStoredProof(form.formId, null);

        return;
      }

      setVerified(null);
    },
    [form.formId, setVerified],
  );

  const getCaptchaToken = useCallback(async () => {
    if (!turnstileSiteKey) {
      return undefined;
    }

    const token = await turnstileRef.current?.getResponsePromise(3000).catch(() => undefined);

    // A Turnstile token works once, so the next request needs a fresh one.
    turnstileRef.current?.reset();

    return token ?? undefined;
  }, [turnstileSiteKey]);

  const getSubmissionPayload = useCallback(
    async () => ({
      openedToken: form.openedToken,
      verifiedProof: verified?.proof,
      honeypot: honeypotRef.current?.value ?? '',
      captchaToken: await getCaptchaToken(),
    }),
    [form.openedToken, verified?.proof, getCaptchaToken],
  );

  const value = useMemo(
    () => ({ form, getSubmissionPayload, clearVerification }),
    [form, getSubmissionPayload, clearVerification],
  );

  const isOpen = form.availability === 'OPEN';
  const needsVerification = isOpen && form.requireVerifiedEmail && !verified;

  return (
    <PublicFormContext.Provider value={value}>
      {/* People never see or reach this input; bots that fill every field do. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="st-form-website">Website</label>
        <input ref={honeypotRef} id="st-form-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {!isOpen && <PublicFormUnavailable form={form} title={title} />}

      {needsVerification && (
        <PublicFormEmailVerification
          form={form}
          title={title}
          getCaptchaToken={getCaptchaToken}
          getHoneypot={() => honeypotRef.current?.value ?? ''}
          onVerified={setVerified}
        />
      )}

      {isOpen && !needsVerification && (
        <>
          {form.introText && <PublicFormIntro text={form.introText} />}
          {children({ verifiedEmail: verified?.email ?? null })}
        </>
      )}

      {turnstileSiteKey && isOpen && (
        <div className="mx-auto flex max-w-md justify-center p-4">
          <Turnstile
            ref={turnstileRef}
            siteKey={turnstileSiteKey}
            options={{ size: 'flexible', appearance: 'interaction-only' }}
          />
        </div>
      )}
    </PublicFormContext.Provider>
  );
};

const PublicFormIntro = ({ text }: { text: string }) => (
  <div className="mx-auto mt-4 w-full max-w-screen-xl px-4 md:px-8">
    <p className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-sm" data-testid="public-form-intro">
      {text}
    </p>
  </div>
);

const PublicFormUnavailable = ({ form, title }: { form: PublicFormForVisitor; title: string }) => {
  const { i18n } = useLingui();

  return (
    <div className="mx-auto mt-16 w-full max-w-lg px-4" data-testid="public-form-unavailable">
      <Card>
        <CardContent className="space-y-2 p-6 text-center">
          <h1 className="font-semibold text-xl">{title}</h1>
          <p className="text-muted-foreground">
            {form.availability === 'NOT_OPEN_YET' && form.opensAt && (
              <Trans>This form opens on {i18n.date(form.opensAt, { dateStyle: 'long', timeStyle: 'short' })}.</Trans>
            )}
            {form.availability === 'CLOSED' && <Trans>This form is closed.</Trans>}
            {form.availability === 'FULL' && <Trans>This form is no longer taking responses.</Trans>}
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

type PublicFormEmailVerificationProps = {
  form: PublicFormForVisitor;
  title: string;
  getCaptchaToken: () => Promise<string | undefined>;
  getHoneypot: () => string;
  onVerified: (value: { email: string; proof: string }) => void;
};

const PublicFormEmailVerification = ({
  form,
  title,
  getCaptchaToken,
  getHoneypot,
  onVerified,
}: PublicFormEmailVerificationProps) => {
  const { t } = useLingui();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: requestCode, isPending: isRequesting } = trpc.publicForm.requestCode.useMutation();
  const { mutateAsync: verifyCode, isPending: isVerifying } = trpc.publicForm.verifyCode.useMutation();

  const onRequestCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const address = email.trim().toLowerCase();

    if (!zEmail().safeParse(address).success) {
      setError(t`Enter a valid email address.`);

      return;
    }

    try {
      await requestCode({
        token: form.token,
        email: address,
        openedToken: form.openedToken,
        honeypot: getHoneypot(),
        captchaToken: await getCaptchaToken(),
      });

      setSentTo(address);
      setCode('');
    } catch (err) {
      setError(AppError.parseError(err).message || t`We could not send the code. Please try again.`);
    }
  };

  const onVerifyCode = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!sentTo) {
      return;
    }

    setError(null);

    try {
      const { proof } = await verifyCode({ token: form.token, email: sentTo, code: code.trim() });

      onVerified({ email: sentTo, proof });
    } catch (err) {
      setError(AppError.parseError(err).message || t`The code is not correct.`);
    }
  };

  return (
    <div className="mx-auto mt-12 w-full max-w-lg px-4" data-testid="public-form-verify-email">
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center gap-x-2">
            <MailCheckIcon className="h-5 w-5 text-primary" />
            <h1 className="font-semibold text-xl">{title}</h1>
          </div>

          {form.introText && <p className="whitespace-pre-wrap text-sm">{form.introText}</p>}

          {!sentTo ? (
            <form className="space-y-3" onSubmit={onRequestCode}>
              <p className="text-muted-foreground text-sm">
                <Trans>Enter your email address. We will send you a 6-digit code to confirm it.</Trans>
              </p>

              <div className="space-y-1">
                <Label htmlFor="public-form-email">
                  <Trans>Email address</Trans>
                </Label>
                <Input
                  id="public-form-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <Button type="submit" className="w-full" loading={isRequesting}>
                <Trans>Send code</Trans>
              </Button>
            </form>
          ) : (
            <form className="space-y-3" onSubmit={onVerifyCode}>
              <p className="text-muted-foreground text-sm">
                <Trans>We sent a 6-digit code to {sentTo}. Enter it below.</Trans>
              </p>

              <div className="space-y-1">
                <Label htmlFor="public-form-code">
                  <Trans>Verification code</Trans>
                </Label>
                <Input
                  id="public-form-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>

              <Button type="submit" className="w-full" loading={isVerifying}>
                <Trans>Confirm code</Trans>
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setSentTo(null);
                  setError(null);
                }}
              >
                <Trans>Use another email address</Trans>
              </Button>
            </form>
          )}

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
