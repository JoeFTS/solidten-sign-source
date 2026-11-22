import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { ChevronLeft } from 'lucide-react';
import { isRouteErrorResponse, Link, Outlet } from 'react-router';

import { Header as AuthenticatedHeader } from '~/components/general/app-header';
import { BrandingLogo } from '~/components/general/branding-logo';
import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import { PublicLegalLinks } from '~/components/general/public-legal-links';
import { SourceCodeNotice } from '~/components/general/source-code-notice';

import type { Route } from './+types/_layout';

/**
 * Solid Ten Sign: the public Help section (/help, /help/:slug, /help/faq). No sign-in needed, so
 * signers can use it too. A signed-in user keeps the normal app header.
 */
export default function HelpLayout() {
  const { sessionData } = useOptionalSession();

  // A device handed to signers in person never shows the host's account header.
  const showAppHeader = Boolean(sessionData?.user) && !sessionData?.session.stInPersonSessionId;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {showAppHeader ? (
        <AuthenticatedHeader />
      ) : (
        <header className="border-border border-b bg-background">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3 md:px-8">
            <Link to="/help" className="flex min-w-0 items-center gap-3" aria-label="Solid Ten Sign Help">
              <BrandingLogo className="h-7 w-auto flex-shrink-0" />
            </Link>

            <nav className="flex items-center gap-4 text-sm">
              <Link to="/help" className="text-muted-foreground hover:text-foreground">
                <Trans>Help</Trans>
              </Link>
              <Link to="/help/faq" className="text-muted-foreground hover:text-foreground">
                <Trans>FAQ</Trans>
              </Link>
            </nav>
          </div>
        </header>
      )}

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-12">
        <Outlet />
      </main>

      <footer className="border-border border-t px-4 py-6">
        <PublicLegalLinks />
        <SourceCodeNotice className="mt-2" showHelp={false} />
      </footer>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const errorCode = isRouteErrorResponse(error) ? error.status : 500;

  return (
    <GenericErrorLayout
      errorCode={errorCode}
      secondaryButton={null}
      primaryButton={
        <Button asChild>
          <Link to="/help">
            <ChevronLeft className="mr-2 h-4 w-4" />
            <Trans>Back to Help</Trans>
          </Link>
        </Button>
      }
    />
  );
}
