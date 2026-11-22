import { useAnalytics } from '@documenso/lib/client-only/hooks/use-analytics';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronLeft } from 'lucide-react';
import { useEffect } from 'react';
import { isRouteErrorResponse, Link, Outlet } from 'react-router';
import { Header as AuthenticatedHeader } from '~/components/general/app-header';
import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import { SourceCodeNotice } from '~/components/general/source-code-notice';
import { retryAfterRouteHeaders } from '~/utils/retry-after-headers';
import type { Route } from './+types/_layout';

export function meta() {
  return [
    { title: i18n._(msg`Sign Document - Solid Ten Sign`) },
    { name: 'robots', content: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
  ];
}

/**
 * A layout to handle scenarios where the user is a recipient of a given resource
 * where we do not care whether they are authenticated or not.
 *
 * Such as direct template access, or signing.
 */
export default function RecipientLayout({ matches }: Route.ComponentProps) {
  const { sessionData } = useOptionalSession();

  // Solid Ten Sign: the signing pages (also used below for the source-link footer).
  const isSigningPage = matches.some(
    (match) =>
      match?.id === 'routes/_recipient+/sign.$token+/_index' || match?.id === 'routes/_recipient+/d.$token+/_index',
  );

  // Hide the header for signing routes.
  // Solid Ten Sign: a sign-in handed to signers in person never shows the host's account header.
  const hideHeader = Boolean(sessionData?.session.stInPersonSessionId) || isSigningPage;

  return (
    <div className="min-h-screen">
      {!hideHeader && sessionData?.user && <AuthenticatedHeader />}

      <main
        className={cn({
          'mt-8 mb-8 px-4 md:mt-12 md:mb-12 md:px-8': !hideHeader,
        })}
      >
        <Outlet />
      </main>

      {/* Solid Ten Sign: the AGPL source link on every recipient page (not in embeds: own layout).
          H-D1: relative z-10 lifts it over the PDF viewer's padded last-page label. On a phone the
          signing page keeps its sign panel fixed at the bottom (z-50, stays on top), so the footer
          gets room to scroll clear of it there. */}
      <footer className={cn('relative z-10 px-4 pt-2 pb-6', isSigningPage && 'pb-40 md:pb-6')}>
        <SourceCodeNotice />
      </footer>
    </div>
  );
}

// Solid Ten: a 429 thrown by a loader below (public form over its open limit) keeps its Retry-After.
export const headers = retryAfterRouteHeaders;

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const analytics = useAnalytics();

  const errorCode = isRouteErrorResponse(error) ? error.status : 500;

  useEffect(() => {
    analytics.captureException(error, { source: 'signing', location: 'recipient_layout_boundary' });
  }, [error]);

  return (
    <GenericErrorLayout
      errorCode={errorCode}
      secondaryButton={null}
      primaryButton={
        <Button asChild className="w-32">
          <Link to="/">
            <ChevronLeft className="mr-2 h-4 w-4" />
            <Trans>Go Back</Trans>
          </Link>
        </Button>
      }
    />
  );
}
