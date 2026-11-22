import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { trpc } from '@documenso/trpc/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

export type SigningLinkStatusWatcherProps = {
  token: string;
};

/**
 * Solid Ten: while a signing page is open, the request may be handed to someone
 * else or the document cancelled. The page's next action then fails; instead of
 * leaving the signer with a generic error, this checks what happened to the link
 * and moves to the page that explains it. It also checks when the tab regains focus
 * and once a minute.
 */
export const SigningLinkStatusWatcher = ({ token }: SigningLinkStatusWatcherProps) => {
  const queryClient = useQueryClient();

  const { data, refetch } = trpc.lifecycle.getSigningLinkStatus.useQuery(
    { token },
    // Not refetched after every mutation: the signer's own "reassign" succeeding would
    // otherwise replace its confirmation with this page.
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION, refetchOnWindowFocus: true, refetchInterval: 60_000, retry: false },
  );

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.mutation.state.status === 'error') {
        void refetch();
      }
    });
  }, [queryClient, refetch]);

  useEffect(() => {
    if (data?.status === 'REASSIGNED') {
      window.location.href = `/sign/${token}/reassigned`;
    }

    if (data?.status === 'CANCELLED') {
      window.location.href = `/sign/${token}/cancelled`;
    }
  }, [data?.status, token]);

  return null;
};
