import { Outlet } from 'react-router';

import { SourceCodeNotice } from '~/components/general/source-code-notice';

export default function Layout() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-12 md:p-12 lg:p-24">
      <div className="relative w-full">
        <Outlet />
      </div>

      <footer className="z-10 mt-8 w-full">
        <SourceCodeNotice />
      </footer>
    </main>
  );
}
