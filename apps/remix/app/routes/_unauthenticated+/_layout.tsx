import backgroundPattern from '@documenso/assets/images/background-pattern.png';
import { Outlet } from 'react-router';

import { BrandingLogo } from '~/components/general/branding-logo';
import { PublicLegalLinks } from '~/components/general/public-legal-links';
import { SourceCodeNotice } from '~/components/general/source-code-notice';

export default function Layout() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-between overflow-hidden px-4 py-12 md:p-12 lg:p-24">
      <div className="flex w-full flex-1 flex-col items-center justify-center">
        <div className="absolute -inset-[min(600px,max(400px,60vw))] -z-[1] flex items-center justify-center opacity-70">
          <img
            src={backgroundPattern}
            alt="background pattern"
            className="dark:brightness-95 dark:contrast-[70%] dark:invert dark:sepia"
            style={{
              mask: 'radial-gradient(rgba(255, 255, 255, 1) 0%, transparent 80%)',
              WebkitMask: 'radial-gradient(rgba(255, 255, 255, 1) 0%, transparent 80%)',
            }}
          />
        </div>

        <div className="relative flex w-full flex-col items-center justify-center">
          <BrandingLogo className="mb-8 h-9 w-auto" />
          <Outlet />
        </div>
      </div>

      <footer className="z-10 mt-8 w-full">
        <PublicLegalLinks />
        <SourceCodeNotice className="mt-2" />
      </footer>
    </main>
  );
}
