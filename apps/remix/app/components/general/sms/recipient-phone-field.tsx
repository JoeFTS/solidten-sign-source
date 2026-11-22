import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { AppError } from '@documenso/lib/errors/app-error';
import { normalizePhoneNumber } from '@documenso/lib/utils/sms/phone';
import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Input } from '@documenso/ui/primitives/input';
import { useLingui } from '@lingui/react/macro';
import { EnvelopeType, RecipientRole } from '@prisma/client';
import { useEffect, useState } from 'react';

import { useTeamSmsEnabled } from './use-team-sms';

export type RecipientPhoneFieldProps = {
  recipientId?: number;
  role: RecipientRole;
  disabled?: boolean;
  className?: string;
};

export const RecipientPhoneField = ({ recipientId, role, disabled, className }: RecipientPhoneFieldProps) => {
  const { t } = useLingui();

  const { envelope, isEmbedded } = useCurrentEnvelopeEditor();

  const isSmsEnabled = useTeamSmsEnabled(envelope.teamId, isEmbedded);

  const isApplicable =
    isSmsEnabled &&
    envelope.type === EnvelopeType.DOCUMENT &&
    envelope.internalVersion === 2 &&
    role !== RecipientRole.CC;

  const utils = trpc.useUtils();

  const { data: smsStatus } = trpc.sms.getEnvelopeStatus.useQuery(
    { envelopeId: envelope.id },
    { enabled: isApplicable },
  );

  const { mutateAsync: setRecipientPhone, isPending } = trpc.sms.setRecipientPhone.useMutation();

  const savedPhone = smsStatus?.recipients.find((r) => r.recipientId === recipientId)?.phoneE164 ?? '';

  const [value, setValue] = useState(savedPhone);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(savedPhone);
  }, [savedPhone]);

  if (!isApplicable) {
    return null;
  }

  const onSave = async () => {
    if (recipientId === undefined) {
      return;
    }

    const trimmed = value.trim();

    if (trimmed === savedPhone) {
      setError(null);
      return;
    }

    if (trimmed !== '' && !normalizePhoneNumber(trimmed).success) {
      setError(t`Enter a mobile number with country code, for example +1 555 123 4567.`);
      return;
    }

    try {
      const result = await setRecipientPhone({
        envelopeId: envelope.id,
        recipientId,
        phoneNumber: trimmed === '' ? null : trimmed,
      });

      setValue(result.phoneE164 ?? '');
      setError(null);

      await utils.sms.getEnvelopeStatus.invalidate({ envelopeId: envelope.id });
    } catch (err) {
      setError(AppError.parseError(err).message || t`We could not save this number.`);
    }
  };

  return (
    <div className={cn('mt-2 w-full', className)}>
      <Input
        type="tel"
        inputMode="tel"
        autoComplete="off"
        aria-label={t`Mobile number for text messages`}
        placeholder={
          recipientId === undefined
            ? t`Mobile number (save the recipient first)`
            : t`Mobile number for texts (optional)`
        }
        value={value}
        maxLength={32}
        disabled={disabled || isPending || recipientId === undefined}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void onSave()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void onSave();
          }
        }}
        data-testid="signer-phone-input"
      />

      {value.trim() !== '' && !error && (
        <p className="mt-1 text-muted-foreground text-xs" data-testid="signer-phone-consent">
          {t`Only text people who agreed to receive texts.`}
        </p>
      )}

      {error && (
        <p className="mt-1 text-destructive text-xs" data-testid="signer-phone-error">
          {error}
        </p>
      )}
    </div>
  );
};
