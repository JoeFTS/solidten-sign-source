import type { TEnvelope } from '@documenso/lib/types/envelope';
import { maskPhoneNumber } from '@documenso/lib/utils/sms/phone';
import { trpc } from '@documenso/trpc/react';
import { Badge } from '@documenso/ui/primitives/badge';
import { useLingui } from '@lingui/react/macro';
import { DateTime } from 'luxon';

import { useTeamSmsEnabled } from './use-team-sms';

export type DocumentPageViewSmsStatusProps = {
  envelope: Pick<TEnvelope, 'id' | 'teamId' | 'recipients'>;
};

export const DocumentPageViewSmsStatus = ({ envelope }: DocumentPageViewSmsStatusProps) => {
  const { t, i18n } = useLingui();

  const isSmsEnabled = useTeamSmsEnabled(envelope.teamId);

  const { data } = trpc.sms.getEnvelopeStatus.useQuery({ envelopeId: envelope.id }, { enabled: isSmsEnabled });

  if (!isSmsEnabled || !data) {
    return null;
  }

  const rows = data.recipients.filter((row) => row.phoneE164 !== null || row.status !== null);

  if (rows.length === 0) {
    return null;
  }

  const failureLabel = (reason: string | null) => {
    switch (reason) {
      case 'INVALID_NUMBER':
        return t`The number is not a valid mobile number.`;
      case 'RATE_LIMITED':
        return t`Too many texts. Try again later.`;
      case 'MESSAGE_TOO_LONG':
        return t`The text was too long.`;
      case 'TIMEOUT':
      case 'PROVIDER_ERROR':
        return t`The text service did not accept the message. The email was sent instead if email was on.`;
      default:
        return t`The text could not be sent.`;
    }
  };

  return (
    <section
      className="flex flex-col rounded-xl border border-border bg-widget dark:bg-background"
      data-testid="document-sms-status"
    >
      <div className="px-4 py-3">
        <h1 className="font-medium text-foreground">{t`Text messages`}</h1>
      </div>

      <ul className="divide-y border-t text-muted-foreground">
        {rows.map((row) => {
          const recipient = envelope.recipients.find((r) => r.id === row.recipientId);

          return (
            <li key={row.recipientId} className="flex flex-col gap-1 px-4 py-2.5 text-sm" data-testid="sms-status-row">
              <div className="flex flex-row items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate">{recipient?.email}</p>
                  <p className="text-muted-foreground/70 text-xs">
                    {row.phoneE164
                      ? row.phoneE164.includes('*')
                        ? row.phoneE164
                        : maskPhoneNumber(row.phoneE164)
                      : t`No mobile number`}
                  </p>
                </div>

                {row.status === 'SENT' && (
                  <Badge variant="default" data-testid="sms-status-badge">
                    {t`Text sent`}
                  </Badge>
                )}
                {row.status === 'FAILED' && (
                  <Badge variant="destructive" data-testid="sms-status-badge">
                    {t`Text failed`}
                  </Badge>
                )}
                {row.status === 'OPTED_OUT' && (
                  <Badge variant="warning" data-testid="sms-status-badge">
                    {t`Opted out`}
                  </Badge>
                )}
                {(row.status === 'NOT_SENT' || row.status === null) && (
                  <Badge variant="neutral" data-testid="sms-status-badge">
                    {t`Not texted`}
                  </Badge>
                )}
              </div>

              {row.status === 'FAILED' && <p className="text-destructive text-xs">{failureLabel(row.lastError)}</p>}

              {row.status === 'OPTED_OUT' && (
                <p className="text-xs">{t`This number replied STOP. Solid Ten Sign will not text it again.`}</p>
              )}

              {row.sentAt && row.status === 'SENT' && (
                <p className="text-xs">
                  {DateTime.fromJSDate(new Date(row.sentAt))
                    .setLocale(i18n.locale)
                    .toLocaleString(DateTime.DATETIME_MED)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
