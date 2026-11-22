import type { HelpTopic } from '@documenso/lib/constants/help/types';
import { cn } from '@documenso/ui/lib/utils';
import { useLingui } from '@lingui/react';
import { ChevronRightIcon } from 'lucide-react';
import { Link } from 'react-router';

export type HelpTopicCardProps = {
  topic: HelpTopic;
  className?: string;
};

/** Solid Ten Sign: one help article as a card that links to /help/:slug. */
export const HelpTopicCard = ({ topic, className }: HelpTopicCardProps) => {
  const { _ } = useLingui();

  return (
    <Link
      to={`/help/${topic.slug}`}
      className={cn(
        'group flex h-full items-start justify-between gap-3 rounded-lg border border-border bg-background p-4 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      data-testid={`help-topic-card-${topic.slug}`}
    >
      <span className="min-w-0">
        <span className="block font-medium text-foreground text-sm">{_(topic.title)}</span>
        <span className="mt-1 block text-muted-foreground text-sm">{_(topic.summary)}</span>
      </span>
      <ChevronRightIcon
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
};
