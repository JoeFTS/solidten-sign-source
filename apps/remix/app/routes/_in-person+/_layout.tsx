import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isRouteErrorResponse, Outlet } from 'react-router';

import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import { SourceCodeNotice } from '~/components/general/source-code-notice';

import type { Route } from './+types/_layout';

export function meta() {
  return [
    { title: i18n._(msg`Sign in person - Solid Ten Sign`) },
    { name: 'robots', content: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
  ];
}

/**
 * In-person signing runs on the host's device. No app navigation here: a
 * signer holding the device must not reach the host's account.
 */
export default function InPersonLayout() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-background">
      <Outlet />

      {/* Solid Ten Sign: above the PDF viewer's padded page label, as in the recipient layout (H-D1). */}
      <footer className="relative z-10 px-4 pt-2 pb-6">
        <SourceCodeNotice />
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
        <a href="/" className="text-documenso-700 text-sm hover:opacity-80">
          <Trans>Start again</Trans>
        </a>
      }
    />
  );
}
