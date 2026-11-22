import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { AppError } from '@documenso/lib/errors/app-error';
import { zEmail } from '@documenso/lib/utils/zod';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const ZRecipientReassignFormSchema = z.object({
  name: z.string().trim().min(1, msg`Enter a name`).max(255),
  email: zEmail().max(254),
  reason: z.string().trim().max(500).optional(),
});

type TRecipientReassignFormSchema = z.infer<typeof ZRecipientReassignFormSchema>;

export type RecipientReassignDialogProps = {
  trigger: React.ReactNode;
} & (
  | {
      mode: 'signer';
      token: string;
    }
  | {
      mode: 'sender';
      envelopeId: string;
      recipientId: number;
      recipientEmail: string;
      onReassigned?: () => void | Promise<void>;
    }
);

/**
 * Hand a signing request to another person. The signer uses it from the signing
 * page with their link; the sender uses it from the document page.
 */
export const RecipientReassignDialog = (props: RecipientReassignDialogProps) => {
  const { t } = useLingui();
  const { toast } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [reassignedTo, setReassignedTo] = useState<string | null>(null);

  const { mutateAsync: reassignWithToken } = trpc.lifecycle.reassignRecipientWithToken.useMutation();
  const { mutateAsync: reassignAsSender } = trpc.lifecycle.reassignRecipient.useMutation();

  const form = useForm<TRecipientReassignFormSchema>({
    resolver: zodResolver(ZRecipientReassignFormSchema),
    defaultValues: { name: '', email: '', reason: '' },
  });

  const onSubmit = async (values: TRecipientReassignFormSchema) => {
    try {
      if (props.mode === 'signer') {
        await reassignWithToken({ token: props.token, ...values });

        // The old link is dead now, so the page behind the dialog cannot be used.
        setReassignedTo(values.name || values.email);

        return;
      }

      await reassignAsSender({ envelopeId: props.envelopeId, recipientId: props.recipientId, ...values });

      toast({
        title: t`Recipient reassigned`,
        description: t`${values.email} has been sent a new signing link.`,
      });

      setIsOpen(false);
      form.reset();

      await props.onReassigned?.();
    } catch (err) {
      const error = AppError.parseError(err);

      toast({
        title: t`Could not reassign`,
        description: error.message || t`Please try again.`,
        variant: 'destructive',
      });
    }
  };

  const onOpenChange = (open: boolean) => {
    // After a signer reassigns there is nothing left to go back to.
    if (reassignedTo) {
      return;
    }

    setIsOpen(open);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{props.trigger}</DialogTrigger>

      <DialogContent hideClose={Boolean(reassignedTo)}>
        {reassignedTo ? (
          <DialogHeader>
            <DialogTitle>
              <Trans>Request passed on</Trans>
            </DialogTitle>

            <DialogDescription data-testid="reassign-done">
              <Trans>
                We have sent {reassignedTo} their own link to this document. Your link no longer works. You can close
                this page.
              </Trans>
            </DialogDescription>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Reassign to someone else</Trans>
              </DialogTitle>

              <DialogDescription>
                {props.mode === 'signer' ? (
                  <Trans>
                    If you are not the right person, pass this request to the person who should act on it. Anything you
                    have filled in will be removed.
                  </Trans>
                ) : (
                  <Trans>
                    {props.recipientEmail} will lose access and the new person gets a fresh signing link. Fields they
                    filled in are cleared.
                  </Trans>
                )}
              </DialogDescription>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)}>
                <fieldset className="space-y-4" disabled={form.formState.isSubmitting}>
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <Trans>Name</Trans>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} maxLength={255} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <Trans>Email</Trans>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} type="email" maxLength={254} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="reason"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <Trans>
                            Reason <span className="text-muted-foreground">(Optional)</span>
                          </Trans>
                        </FormLabel>
                        <FormControl>
                          <Textarea {...field} rows={3} maxLength={500} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <DialogFooter>
                    <Button type="button" variant="secondary" onClick={() => setIsOpen(false)}>
                      <Trans>Cancel</Trans>
                    </Button>

                    <Button type="submit" loading={form.formState.isSubmitting}>
                      <Trans>Reassign</Trans>
                    </Button>
                  </DialogFooter>
                </fieldset>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export type SignerReassignButtonProps = {
  token: string;
  trigger: React.ReactNode;
};

/**
 * Renders the signer's reassign dialog only when the team allows it for this link.
 */
export const SignerReassignDialog = ({ token, trigger }: SignerReassignButtonProps) => {
  // Not refetched after the reassign mutation: the old token then reads as "no",
  // which would unmount the dialog that is showing the success message.
  const { data } = trpc.lifecycle.getSignerReassignOptions.useQuery(
    { token },
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION },
  );

  if (!data?.canReassign) {
    return null;
  }

  return <RecipientReassignDialog mode="signer" token={token} trigger={trigger} />;
};
