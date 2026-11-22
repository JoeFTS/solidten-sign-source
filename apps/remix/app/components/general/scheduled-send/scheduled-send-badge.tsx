import { formatScheduledSendTime } from '@documenso/lib/utils/scheduled-send';
import { trpc } from '@documenso/trpc/react';
import type { ZFindScheduledSendsResponseSchema } from '@documenso/trpc/server/lifecycle-router/find-scheduled-sends.types';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Popover, PopoverContent, PopoverTrigger } from '@documenso/ui/primitives/popover';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { EnvelopeScheduledSendStatus } from '@prisma/client';
import { AlertTriangleIcon, CalendarClockIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { z } from 'zod';

import { getBrowserTimezone } from './schedule-send-fields';

type ScheduledSendRow = z.infer<typeof ZFindScheduledSendsResponseSchema>[number];

/**
 * A list page loads the schedules of all its drafts with one query and shares them here, so
 * each badge does not send its own request (one per row re-rendered the rows after load).
 * `rows` is undefined while the shared query loads.
 */
const ScheduledSendLookupContext = createContext<{ rows: ScheduledSendRow[] | undefined } | null>(null);

export const ScheduledSendLookupProvider = ({
  envelopeIds,
  children,
}: {
  envelopeIds: string[];
  children: ReactNode;
}) => {
  const { data } = trpc.lifecycle.findScheduledSends.useQuery({ envelopeIds }, { enabled: envelopeIds.length > 0 });

  const value = useMemo(() => ({ rows: envelopeIds.length > 0 ? data : [] }), [data, envelopeIds.length]);

  return <ScheduledSendLookupContext.Provider value={value}>{children}</ScheduledSendLookupContext.Provider>;
};

export type ScheduledSendBadgeProps = {
  envelopeId: string;
  /**
   * Show the un-schedule action. Off in lists, on in the editor.
   */
  allowUnschedule?: boolean;
};

/**
 * Shows "Scheduled" (or "Scheduled send failed") for a draft that has a scheduled send.
 */
export const ScheduledSendBadge = ({ envelopeId, allowUnschedule = false }: ScheduledSendBadgeProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const lookup = useContext(ScheduledSendLookupContext);

  const { data: ownData } = trpc.lifecycle.findScheduledSends.useQuery(
    { envelopeIds: [envelopeId] },
    { enabled: lookup === null },
  );

  const data = lookup ? lookup.rows : ownData;

  const { mutateAsync: unscheduleSend, isPending } = trpc.lifecycle.unscheduleSend.useMutation({
    onSuccess: async () => {
      await utils.lifecycle.findScheduledSends.invalidate();
    },
  });

  const scheduledSend = data?.find((row) => row.envelopeId === envelopeId);

  if (!scheduledSend || scheduledSend.status === EnvelopeScheduledSendStatus.SENT) {
    return null;
  }

  // Shown in the viewer's own timezone, named, as visible text (no hover needed on touch screens).
  const viewerTimezone = getBrowserTimezone();
  const viewerTime = `${formatScheduledSendTime(scheduledSend.scheduledAt, viewerTimezone)} (${viewerTimezone})`;
  const senderTime = `${formatScheduledSendTime(scheduledSend.scheduledAt, scheduledSend.timezone)} (${scheduledSend.timezone})`;
  const time = viewerTime;
  const isFailed = scheduledSend.status === EnvelopeScheduledSendStatus.FAILED;

  const onUnschedule = async () => {
    try {
      await unscheduleSend({ envelopeId });

      toast({
        title: t`Schedule removed`,
        description: t`The document stays a draft.`,
      });
    } catch {
      toast({
        title: t`Could not remove the schedule`,
        description: t`The document may be sending now. Reload the page to check.`,
        variant: 'destructive',
      });
    }
  };

  const badge = isFailed ? (
    <Badge variant="destructive" className="shrink-0" data-testid="scheduled-send-badge">
      <AlertTriangleIcon className="mr-1 h-3 w-3" />
      <Trans>Scheduled send failed</Trans>
    </Badge>
  ) : (
    <Badge variant="secondary" className="shrink-0" data-testid="scheduled-send-badge">
      <CalendarClockIcon className="mr-1 h-3 w-3" />
      <span>
        <Trans>Scheduled</Trans>
        <span className="block font-normal text-[11px]" data-testid="scheduled-send-time">
          {viewerTime}
        </span>
      </span>
    </Badge>
  );

  if (!allowUnschedule) {
    return badge;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t`Scheduled send details`}>
          {badge}
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 space-y-3 text-sm">
        {isFailed ? (
          <>
            <p>
              <Trans>The send scheduled for {time} failed.</Trans>
            </p>
            {scheduledSend.lastError && <p className="text-muted-foreground">{scheduledSend.lastError}</p>}
          </>
        ) : (
          <p>
            <Trans>This document will be sent on {time}. You can keep editing it until then.</Trans>
          </p>
        )}

        {!isFailed && scheduledSend.timezone !== viewerTimezone && (
          <p className="text-muted-foreground">
            <Trans>The sender picked {senderTime}.</Trans>
          </p>
        )}

        <Button variant="outline" size="sm" loading={isPending} onClick={onUnschedule}>
          {isFailed ? <Trans>Dismiss</Trans> : <Trans>Cancel schedule</Trans>}
        </Button>
      </PopoverContent>
    </Popover>
  );
};
