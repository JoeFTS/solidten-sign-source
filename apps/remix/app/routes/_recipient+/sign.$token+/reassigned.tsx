import { getSigningLinkStatus } from '@documenso/lib/server-only/recipient-reassign/get-signing-link-status';
import { Trans } from '@lingui/react/macro';
import { UserRoundPenIcon } from 'lucide-react';

import type { Route } from './+types/reassigned';

export async function loader({ params }: Route.LoaderArgs) {
  const { token } = params;

  // Only for links that were handed over. Nothing about the document is shown:
  // the holder of this link no longer has access to it.
  if (!token || (await getSigningLinkStatus({ token })) !== 'REASSIGNED') {
    throw new Response('Not Found', { status: 404 });
  }

  return null;
}

/**
 * Solid Ten: what an old signing link shows after the request was handed to
 * someone else (reassigned, or the recipient's email or phone changed).
 */
export default function ReassignedSigningPage() {
  return (
    <div className="flex flex-col items-center pt-24 lg:pt-36 xl:pt-44">
      <div className="flex flex-col items-center">
        <div className="flex items-center gap-x-4">
          <UserRoundPenIcon className="h-10 w-10 text-muted-foreground" />

          <h2 className="max-w-[35ch] text-center font-semibold text-2xl leading-normal md:text-3xl lg:text-4xl">
            <Trans>This request was passed to someone else</Trans>
          </h2>
        </div>

        <p className="mt-6 max-w-[60ch] text-center text-muted-foreground text-sm">
          <Trans>This signing link no longer works. Contact the sender if this is wrong.</Trans>
        </p>
      </div>
    </div>
  );
}
