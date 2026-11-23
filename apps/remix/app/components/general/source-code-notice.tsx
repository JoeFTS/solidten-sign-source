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
 * Solid Ten Sign (AGPL-3.0 section 13): one quiet footer line that tells every user of the
 * service where the source code is. It also carries the "Help" link of the public pages.
 *
 * Joe, 2026-11-22: no sentence about the license, only a small plain "Source code" link after
 * "Help". The link stays on every page, with its plain label: the license asks for that.
 */
export const SourceCodeNotice = ({ className, showHelp = true }: SourceCodeNoticeProps) => (
  <div className={cn('text-center text-[11px] text-muted-foreground/70', className)} data-testid="source-code-notice">
    {showHelp && (
      <>
        <HelpFooterLink className="no-underline hover:underline" />
        <span aria-hidden="true"> · </span>
      </>
    )}
    <a
      href={NEXT_PUBLIC_ST_SOURCE_URL()}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-2 duration-200 hover:text-foreground hover:underline"
      data-testid="source-code-link"
    >
      <Trans>Source code</Trans>
    </a>
  </div>
);
