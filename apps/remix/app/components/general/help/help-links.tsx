import { cn } from '@documenso/ui/lib/utils';
import { Trans } from '@lingui/react/macro';
import { CircleHelpIcon } from 'lucide-react';

export const HELP_PATH = '/help';
export const HOW_TO_SIGN_HELP_PATH = '/help/how-to-sign';

export type HelpLinkProps = {
  className?: string;
};

/**
 * Solid Ten Sign: the quiet "Help" link in public footers. It opens a new tab, so a signer never
 * leaves the signing page by accident.
 */
export const HelpFooterLink = ({ className }: HelpLinkProps) => (
  <a
    href={HELP_PATH}
    target="_blank"
    rel="noopener noreferrer"
    className={cn('underline underline-offset-2 duration-200 hover:text-foreground', className)}
    data-testid="help-footer-link"
  >
    <Trans>Help</Trans>
  </a>
);

/**
 * Solid Ten Sign: "Need help signing?" on the signing pages. A plain text link in the page flow
 * (never fixed or floating), so it cannot cover a signing control. Opens a new tab.
 */
export const SigningHelpLink = ({ className }: HelpLinkProps) => (
  <a
    href={HOW_TO_SIGN_HELP_PATH}
    target="_blank"
    rel="noopener noreferrer"
    className={cn(
      'inline-flex items-center gap-1 text-muted-foreground text-xs underline-offset-2 duration-200 hover:text-foreground hover:underline',
      className,
    )}
    data-testid="signing-help-link"
  >
    <CircleHelpIcon className="h-3.5 w-3.5" aria-hidden="true" />
    <Trans>Need help signing?</Trans>
  </a>
);
