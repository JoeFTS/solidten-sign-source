import { cn } from '@documenso/ui/lib/utils';
import { Trans } from '@lingui/react/macro';

export type CommentListItem = {
  id: string;
  authorType: 'RECIPIENT' | 'TEAM';
  label: string;
  time: string;
  body: string;
};

export type CommentListProps = {
  comments: CommentListItem[];
  emptyText: string;
};

/**
 * Comments are plain text. They are rendered as React text children, never as
 * HTML, so markup a signer types shows exactly as typed.
 */
export const CommentList = ({ comments, emptyText }: CommentListProps) => {
  if (comments.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyText}</p>;
  }

  return (
    <ul className="max-h-80 space-y-3 overflow-y-auto" data-testid="comment-list">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className={cn(
            'rounded-md border p-3 text-sm',
            comment.authorType === 'TEAM' ? 'bg-muted/50' : 'bg-background',
          )}
          data-testid="comment-item"
        >
          <div className="flex items-baseline justify-between gap-2 text-muted-foreground text-xs">
            <span className="truncate font-medium text-foreground">
              {comment.label}
              {comment.authorType === 'TEAM' && (
                <span className="ml-1 font-normal text-muted-foreground">
                  <Trans>(sender's team)</Trans>
                </span>
              )}
            </span>
            <span className="flex-shrink-0">{comment.time}</span>
          </div>

          <p className="mt-1 whitespace-pre-wrap break-words" data-testid="comment-body">
            {comment.body}
          </p>
        </li>
      ))}
    </ul>
  );
};
