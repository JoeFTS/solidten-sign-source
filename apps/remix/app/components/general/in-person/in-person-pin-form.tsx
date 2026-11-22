import { AppError } from '@documenso/lib/errors/app-error';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Trans, useLingui } from '@lingui/react/macro';
import { useId, useState } from 'react';

export type InPersonPinFormProps = {
  label: string;
  submitLabel: string;
  onSubmit: (pin: string) => Promise<void>;
  testId?: string;
};

/**
 * The host's PIN. The server checks it; too many wrong PINs sign the device out.
 */
export const InPersonPinForm = ({ label, submitLabel, onSubmit, testId }: InPersonPinFormProps) => {
  const { t } = useLingui();
  const id = useId();

  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    setError(null);
    setIsPending(true);

    try {
      await onSubmit(pin);
    } catch (err) {
      setError(AppError.parseError(err).message || t`Something went wrong. Please try again.`);
      setPin('');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3" data-testid={testId}>
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        />
      </div>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" loading={isPending} disabled={pin.length < 4}>
        {submitLabel}
      </Button>

      <p className="text-muted-foreground text-xs">
        <Trans>Forgot the PIN? End in-person signing from the document page on another device.</Trans>
      </p>
    </form>
  );
};
