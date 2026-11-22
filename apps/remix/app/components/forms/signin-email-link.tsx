import { authClient } from '@documenso/auth/client';
import { zEmail } from '@documenso/lib/utils/zod';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trans } from '@lingui/react/macro';
import { MailCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const ZSignInEmailLinkFormSchema = z.object({
  email: zEmail().min(1),
});

type TSignInEmailLinkFormSchema = z.infer<typeof ZSignInEmailLinkFormSchema>;

export type SignInEmailLinkFormProps = {
  className?: string;
};

/** Passwordless sign-in: the person enters an email and gets a single-use link. */
export const SignInEmailLinkForm = ({ className }: SignInEmailLinkFormProps) => {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [isRateLimited, setIsRateLimited] = useState(false);

  const form = useForm<TSignInEmailLinkFormSchema>({
    values: {
      email: '',
    },
    resolver: zodResolver(ZSignInEmailLinkFormSchema),
  });

  const isSubmitting = form.formState.isSubmitting;

  const onFormSubmit = async ({ email }: TSignInEmailLinkFormSchema) => {
    setIsRateLimited(false);

    try {
      await authClient.emailLink.request({ email });

      setSentTo(email);
    } catch (_err) {
      setIsRateLimited(true);
    }
  };

  if (sentTo) {
    return (
      <div className={cn('flex w-full flex-col items-center gap-y-3 py-4 text-center', className)}>
        <MailCheckIcon className="h-8 w-8 text-primary" />

        <p className="font-semibold text-lg">
          <Trans>Check your email</Trans>
        </p>

        <p className="text-muted-foreground text-sm">
          <Trans>
            If {sentTo} has an account, a sign-in link is on its way. The link works one time and expires in 15
            minutes.
          </Trans>
        </p>

        <Button type="button" variant="outline" onClick={() => setSentTo(null)}>
          <Trans>Use a different email</Trans>
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form className={cn('flex w-full flex-col gap-y-4', className)} onSubmit={form.handleSubmit(onFormSubmit)}>
        <fieldset className="flex w-full flex-col gap-y-4" disabled={isSubmitting}>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Email</Trans>
                </FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>

        {isRateLimited && (
          <p className="text-destructive text-sm">
            <Trans>We could not send a link right now. Wait a few minutes, then try again.</Trans>
          </p>
        )}

        <Button type="submit" size="lg" loading={isSubmitting}>
          {isSubmitting ? <Trans>Sending link...</Trans> : <Trans>Email me a sign-in link</Trans>}
        </Button>

        <p className="text-center text-muted-foreground text-xs">
          <Trans>No password needed. We email you a link that signs you in.</Trans>
        </p>
      </form>
    </Form>
  );
};
