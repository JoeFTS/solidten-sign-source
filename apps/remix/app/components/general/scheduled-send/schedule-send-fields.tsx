import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Switch } from '@documenso/ui/primitives/switch';
import { Trans } from '@lingui/react/macro';
import { DateTime } from 'luxon';
import { useId } from 'react';

export type ScheduleSendValue = {
  isEnabled: boolean;
  localDateTime: string;
  timezone: string;
};

export const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';

export const createDefaultScheduleSendValue = (): ScheduleSendValue => {
  const timezone = getBrowserTimezone();

  return {
    isEnabled: false,
    localDateTime: DateTime.now()
      .setZone(timezone)
      .plus({ days: 1 })
      .set({ hour: 9, minute: 0 })
      .toFormat("yyyy-MM-dd'T'HH:mm"),
    timezone,
  };
};

export type ScheduleSendFieldsProps = {
  value: ScheduleSendValue;
  onChange: (value: ScheduleSendValue) => void;
  disabled?: boolean;
};

/**
 * "Send later" switch and time picker for the send dialog. The time is the
 * sender's wall clock; the server converts it with the timezone shown here.
 */
export const ScheduleSendFields = ({ value, onChange, disabled }: ScheduleSendFieldsProps) => {
  const switchId = useId();
  const inputId = useId();

  return (
    <div className="mt-4 rounded-lg border p-3" data-testid="schedule-send-fields">
      <div className="flex items-center justify-between">
        <Label htmlFor={switchId}>
          <Trans>Send later</Trans>
        </Label>

        <Switch
          id={switchId}
          checked={value.isEnabled}
          disabled={disabled}
          onCheckedChange={(isEnabled) => onChange({ ...value, isEnabled })}
        />
      </div>

      {value.isEnabled && (
        <div className="mt-3 space-y-1">
          <Label htmlFor={inputId}>
            <Trans>Send on</Trans>
          </Label>

          <Input
            id={inputId}
            type="datetime-local"
            value={value.localDateTime}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, localDateTime: event.target.value.slice(0, 16) })}
          />

          <p className="text-muted-foreground text-xs">
            <Trans>Time zone: {value.timezone}</Trans>
          </p>
        </div>
      )}
    </div>
  );
};
