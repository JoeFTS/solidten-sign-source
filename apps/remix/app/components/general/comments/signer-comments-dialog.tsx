import { AppError } from '@documenso/lib/errors/app-error';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@documenso/ui/primitives/dialog';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { Trans, useLingui } from '@lingui/react/macro';
import { DateTime } from 'luxon';
import { useState } from 'react';

import { CommentList } from './comment-list';

export type SignerCommentsDialogProps = {
  token: string;
  /** Called with a click handler; render nothing when comments are off. */
  renderTrigger: (onOpen: () => void) => React.ReactNode;
};

/**
 * A signer's questions and notes to the sender's team, on the signing page.
 * Renders nothing unless the sender turned comments on for this document.
 */
export const SignerCommentsDialog = ({ token, renderTrigger }: SignerCommentsDialogProps) => {
  const { t } = useLingui();

  const [isOpen, setIsOpen] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  const { data } = trpc.comment.getForRecipient.useQuery({ token }, { retry: false });

  const { mutateAsync: post, isPending } = trpc.comment.postAsRecipient.useMutation({
    onSuccess: async () => {
      await utils.comment.getForRecipient.invalidate({ token });
    },
  });

  if (!data?.enabled) {
    return null;
  }

  const onSend = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await post({ token, body });
      setBody('');
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
    }
  };

  return (
    <>
      {renderTrigger(() => setIsOpen(true))}

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-lg" data-testid="signer-comments-dialog">
          <DialogHeader>
            <DialogTitle>
              <Trans>Questions and comments</Trans>
            </DialogTitle>
            <DialogDescription>
              {data.sharedThread ? (
                <Trans>Everyone asked to sign this document can read this conversation, and so can the sender.</Trans>
              ) : (
                <Trans>Only you and the sender's team can read this conversation.</Trans>
              )}
            </DialogDescription>
          </DialogHeader>

          <CommentList
            comments={data.comments.map((comment) => ({
              ...comment,
              label: comment.isOwn ? t`You` : comment.authorName,
              time: DateTime.fromJSDate(comment.createdAt).toLocaleString(DateTime.DATETIME_SHORT),
            }))}
            emptyText={t`No comments yet. Ask a question before you sign.`}
          />

          {data.isClosed ? (
            <p className="text-muted-foreground text-sm">
              {data.closedMessage ?? <Trans>Comments are closed for you on this document.</Trans>}
            </p>
          ) : (
            <form onSubmit={onSend} className="space-y-2">
              <Textarea
                aria-label={t`Your comment`}
                value={body}
                maxLength={data.maxLength}
                rows={4}
                onChange={(event) => setBody(event.target.value)}
              />

              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                  {body.length} / {data.maxLength}
                </span>

                <Button type="submit" loading={isPending} disabled={body.trim().length === 0}>
                  <Trans>Send</Trans>
                </Button>
              </div>

              {error && (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              )}
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
