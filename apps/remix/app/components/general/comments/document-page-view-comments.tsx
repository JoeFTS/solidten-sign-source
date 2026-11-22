import { AppError } from '@documenso/lib/errors/app-error';
import type { TTeamCommentThread } from '@documenso/lib/server-only/envelope-comments/envelope-comments';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { trpc } from '@documenso/trpc/react';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Label } from '@documenso/ui/primitives/label';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { DateTime } from 'luxon';
import { useState } from 'react';

import { CommentList } from './comment-list';

export type DocumentPageViewCommentsProps = {
  envelope: Pick<TEnvelope, 'id' | 'internalVersion'>;
};

/**
 * Comments from signers and the team's replies, on the document page. Collapsed
 * by default; opening it marks everything read.
 */
export const DocumentPageViewComments = ({ envelope }: DocumentPageViewCommentsProps) => {
  const { t } = useLingui();
  const { toast } = useToast();

  const [isExpanded, setIsExpanded] = useState(false);

  const { data, refetch } = trpc.comment.getForEnvelope.useQuery(
    { envelopeId: envelope.id },
    { enabled: envelope.internalVersion === 2 },
  );

  const { mutateAsync: markRead } = trpc.comment.markRead.useMutation();
  const { mutateAsync: updateSettings, isPending: isUpdatingSettings } = trpc.comment.updateSettings.useMutation();

  if (!data || !data.isSupported) {
    return null;
  }

  const onExpand = async () => {
    setIsExpanded(true);

    if (data.unreadCount > 0) {
      await markRead({ envelopeId: envelope.id }).catch(() => null);
      await refetch();
    }
  };

  const onSettingsChange = async (next: { enabled: boolean; sharedThread: boolean }) => {
    try {
      await updateSettings({ envelopeId: envelope.id, ...next });
      await refetch();
    } catch (err) {
      toast({
        title: t`Something went wrong`,
        description: AppError.parseError(err).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <section
      className="flex flex-col rounded-xl border border-border bg-widget dark:bg-background"
      data-testid="document-comments"
    >
      <div className="flex flex-row items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <h1 className="font-medium text-foreground">
            <Trans>Comments</Trans>
          </h1>

          {data.unreadCount > 0 && (
            <Badge variant="warning" size="small" data-testid="comments-unread">
              <Plural value={data.unreadCount} one="# new" other="# new" />
            </Badge>
          )}
        </div>

        {isExpanded ? (
          <Button size="sm" variant="ghost" onClick={() => setIsExpanded(false)}>
            <Trans>Hide</Trans>
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onExpand}>
            <Trans>Show</Trans>
          </Button>
        )}
      </div>

      {isExpanded && (
        <div className="space-y-4 border-t px-4 py-3">
          {data.isClosed ? (
            <p className="text-muted-foreground text-sm">{data.closedMessage}</p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="comments-enabled"
                  checked={data.settings.enabled}
                  disabled={isUpdatingSettings}
                  onCheckedChange={(checked) =>
                    onSettingsChange({ enabled: checked === true, sharedThread: data.settings.sharedThread })
                  }
                />
                <Label htmlFor="comments-enabled" className="font-normal">
                  <Trans>Signers can ask questions on this document</Trans>
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="comments-shared-thread"
                  checked={data.settings.sharedThread}
                  disabled={isUpdatingSettings || !data.settings.enabled}
                  onCheckedChange={(checked) =>
                    onSettingsChange({ enabled: data.settings.enabled, sharedThread: checked === true })
                  }
                />
                <Label htmlFor="comments-shared-thread" className="font-normal">
                  <Trans>All recipients share one thread</Trans>
                </Label>
              </div>

              {data.settings.isTeamDefault && (
                <p className="text-muted-foreground text-xs">
                  <Trans>These follow your team's default until you change them here.</Trans>
                </p>
              )}
            </div>
          )}

          {data.threads.length === 0 && (
            <p className="text-muted-foreground text-sm">
              <Trans>No comments yet.</Trans>
            </p>
          )}

          {data.threads.map((thread) => (
            <CommentThread
              key={thread.id}
              envelopeId={envelope.id}
              thread={thread}
              canReply={!data.isClosed && data.settings.enabled}
              maxLength={data.maxLength}
              onChanged={async () => {
                await refetch();
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
};

type Thread = TTeamCommentThread;

const CommentThread = ({
  envelopeId,
  thread,
  canReply,
  maxLength,
  onChanged,
}: {
  envelopeId: string;
  thread: Thread;
  canReply: boolean;
  maxLength: number;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();

  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: reply, isPending: isReplying } = trpc.comment.reply.useMutation();
  const { mutateAsync: setResolved, isPending: isResolving } = trpc.comment.setResolved.useMutation();

  const onReply = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await reply({ envelopeId, threadId: thread.id, body });
      setBody('');
      await onChanged();
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
    }
  };

  return (
    <div className="rounded-lg border p-3" data-testid={`comment-thread-${thread.id}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">
            {thread.isShared ? <Trans>All recipients</Trans> : thread.recipientName}
          </p>
          {thread.isPreviousRecipient && (
            <p className="text-muted-foreground text-xs">
              <Trans>This recipient was reassigned. The new person cannot see this thread.</Trans>
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {thread.resolvedAt && (
            <Badge variant="default" size="small">
              <Trans>Resolved</Trans>
            </Badge>
          )}

          <Button
            size="sm"
            variant="ghost"
            loading={isResolving}
            onClick={async () => {
              await setResolved({ envelopeId, threadId: thread.id, resolved: !thread.resolvedAt });
              await onChanged();
            }}
          >
            {thread.resolvedAt ? <Trans>Reopen</Trans> : <Trans>Resolve</Trans>}
          </Button>
        </div>
      </div>

      <CommentList
        comments={thread.comments.map((comment) => ({
          ...comment,
          label: comment.authorName,
          time: DateTime.fromJSDate(comment.createdAt).toLocaleString(DateTime.DATETIME_SHORT),
        }))}
        emptyText={t`No comments yet.`}
      />

      {canReply && !thread.isPreviousRecipient && (
        <form onSubmit={onReply} className="mt-3 space-y-2">
          <Textarea
            aria-label={t`Your reply`}
            value={body}
            maxLength={maxLength}
            rows={3}
            onChange={(event) => setBody(event.target.value)}
          />

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" size="sm" loading={isReplying} disabled={body.trim().length === 0}>
            <Trans>Reply</Trans>
          </Button>
        </form>
      )}
    </div>
  );
};
