import { useSession } from '@documenso/lib/client-only/providers/session';
import { ZNameSchema } from '@documenso/lib/types/name';
import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { getCredentialStepUpError } from '~/utils/credential-step-up-error';

export type SettingsSecurityPasskeyTableActionsProps = {
  className?: string;
  passkeyId: string;
  passkeyName: string;
};

const ZUpdatePasskeySchema = z.object({
  name: ZNameSchema,
  // Solid Ten Sign (AUD-C10 follow-up): needed when the account has 2FA on.
  twoFactorCode: z.string().max(64).optional(),
});

type TUpdatePasskeySchema = z.infer<typeof ZUpdatePasskeySchema>;

export const SettingsSecurityPasskeyTableActions = ({
  className,
  passkeyId,
  passkeyName,
}: SettingsSecurityPasskeyTableActionsProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();
  const { user } = useSession();

  const [deleteTwoFactorCode, setDeleteTwoFactorCode] = useState('');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);

  const form = useForm<TUpdatePasskeySchema>({
    resolver: zodResolver(ZUpdatePasskeySchema),
    defaultValues: {
      name: passkeyName,
      twoFactorCode: '',
    },
  });

  const { mutateAsync: updatePasskey, isPending: isUpdatingPasskey } = trpc.auth.passkey.update.useMutation({
    onSuccess: () => {
      toast({
        title: _(msg`Success`),
        description: _(msg`Passkey has been updated`),
      });

      setIsUpdateDialogOpen(false);
    },
    onError: (err) => {
      toast({
        title: _(msg`Something went wrong`),
        description: _(
          getCredentialStepUpError(err) ??
            msg`We are unable to update this passkey at the moment. Please try again later.`,
        ),
        duration: 10000,
        variant: 'destructive',
      });
    },
  });

  const { mutateAsync: deletePasskey, isPending: isDeletingPasskey } = trpc.auth.passkey.delete.useMutation({
    onSuccess: () => {
      toast({
        title: _(msg`Success`),
        description: _(msg`Passkey has been removed`),
      });

      setIsDeleteDialogOpen(false);
    },
    onError: (err) => {
      toast({
        title: _(msg`Something went wrong`),
        description: _(
          getCredentialStepUpError(err) ??
            msg`We are unable to remove this passkey at the moment. Please try again later.`,
        ),
        duration: 10000,
        variant: 'destructive',
      });
    },
  });

  return (
    <div className={cn('flex justify-end space-x-2', className)}>
      <Dialog open={isUpdateDialogOpen} onOpenChange={(value) => !isUpdatingPasskey && setIsUpdateDialogOpen(value)}>
        <DialogTrigger onClick={(e) => e.stopPropagation()} asChild>
          <Button variant="outline">
            <Trans>Edit</Trans>
          </Button>
        </DialogTrigger>

        <DialogContent position="center">
          <DialogHeader>
            <DialogTitle>
              <Trans>Update passkey</Trans>
            </DialogTitle>

            <DialogDescription className="mt-4">
              <Trans>
                You are currently updating the <strong>{passkeyName}</strong> passkey.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(async ({ name, twoFactorCode }) =>
                updatePasskey({
                  passkeyId,
                  name,
                  twoFactorCode: user.twoFactorEnabled ? twoFactorCode : undefined,
                }),
              )}
            >
              <fieldset className="flex h-full flex-col" disabled={isUpdatingPasskey}>
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="w-full">
                      <FormLabel required>
                        <Trans>Name</Trans>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {user.twoFactorEnabled && (
                  <FormField
                    control={form.control}
                    name="twoFactorCode"
                    render={({ field }) => (
                      <FormItem className="mt-4 w-full">
                        <FormLabel required>
                          <Trans>Authenticator code</Trans>
                        </FormLabel>
                        <FormControl>
                          <Input autoComplete="one-time-code" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <DialogFooter className="mt-4">
                  <DialogClose asChild>
                    <Button type="button" variant="secondary">
                      <Trans>Cancel</Trans>
                    </Button>
                  </DialogClose>

                  <Button type="submit" loading={isUpdatingPasskey}>
                    <Trans>Update</Trans>
                  </Button>
                </DialogFooter>
              </fieldset>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={isDeleteDialogOpen} onOpenChange={(value) => !isDeletingPasskey && setIsDeleteDialogOpen(value)}>
        <DialogTrigger onClick={(e) => e.stopPropagation()} asChild={true}>
          <Button variant="destructive">
            <Trans>Delete</Trans>
          </Button>
        </DialogTrigger>

        <DialogContent position="center">
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete passkey</Trans>
            </DialogTitle>

            <DialogDescription className="mt-4">
              <Trans>
                Are you sure you want to remove the <strong>{passkeyName}</strong> passkey?
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <fieldset disabled={isDeletingPasskey}>
            {user.twoFactorEnabled && (
              <div className="mb-4 flex flex-col gap-2">
                <label htmlFor={`passkey-delete-code-${passkeyId}`} className="font-medium text-sm">
                  <Trans>Authenticator code</Trans>
                </label>
                <Input
                  id={`passkey-delete-code-${passkeyId}`}
                  autoComplete="one-time-code"
                  value={deleteTwoFactorCode}
                  onChange={(event) => setDeleteTwoFactorCode(event.target.value)}
                />
              </div>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  <Trans>Cancel</Trans>
                </Button>
              </DialogClose>

              <Button
                onClick={async () =>
                  deletePasskey({
                    passkeyId,
                    twoFactorCode: user.twoFactorEnabled ? deleteTwoFactorCode : undefined,
                  })
                }
                variant="destructive"
                loading={isDeletingPasskey}
              >
                <Trans>Delete</Trans>
              </Button>
            </DialogFooter>
          </fieldset>
        </DialogContent>
      </Dialog>
    </div>
  );
};
