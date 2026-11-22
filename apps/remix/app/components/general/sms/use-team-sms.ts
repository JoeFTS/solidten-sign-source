import { env } from '@documenso/lib/utils/env';
import { trpc } from '@documenso/trpc/react';

/**
 * Text message UI shows only when the server has a provider and the team turned texts on.
 */
export const useTeamSmsEnabled = (teamId: number | undefined, isEmbedded = false) => {
  const isServerEnabled = env('NEXT_PUBLIC_SMS_ENABLED') === 'true';

  const { data } = trpc.sms.getTeamSettings.useQuery(
    { teamId: teamId ?? 0 },
    { enabled: isServerEnabled && !isEmbedded && teamId !== undefined, staleTime: 60_000 },
  );

  return Boolean(isServerEnabled && !isEmbedded && data?.isEnabled);
};
