import { NEXT_PUBLIC_ST_SOURCE_URL } from '@documenso/lib/constants/source-code';
import { cn } from '@documenso/ui/lib/utils';
import { Trans } from '@lingui/react/macro';

import { HelpFooterLink } from '~/components/general/help/help-links';

export type SourceCodeNoticeProps = {
  className?: string;
  /** Solid Ten Sign: add the "Help" link after the source link (default true). */
  showHelp?: boolean;
};

/**
 * Solid Ten Sign (AGPL-3.0 section 13): one quiet line that tells every user of the service where
 * the source code is. It also carries the "Help" link of the public pages.
 */
export const SourceCodeNotice = ({ className, showHelp = true }: SourceCodeNoticeProps) => (
  <p className={cn('text-center text-muted-foreground text-xs', className)} data-testid="source-code-notice">
    <Trans>Solid Ten Sign is open source (AGPL-3.0).</Trans>{' '}
    <a
      href={NEXT_PUBLIC_ST_SOURCE_URL()}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 duration-200 hover:text-foreground"
      data-testid="source-code-link"
    >
      <Trans>Source code</Trans>
    </a>
    {showHelp && (
      <>
        <span aria-hidden="true"> · </span>
        <HelpFooterLink />
      </>
    )}
  </p>
);
