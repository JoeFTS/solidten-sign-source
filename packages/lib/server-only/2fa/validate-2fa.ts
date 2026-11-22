import type { User } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { consumeBackupCode } from './consume-backup-code';
import { verifyTwoFactorAuthenticationToken } from './verify-2fa-token';

type ValidateTwoFactorAuthenticationOptions = {
  totpCode?: string;
  backupCode?: string;
  user: Pick<User, 'id' | 'email' | 'twoFactorEnabled' | 'twoFactorSecret' | 'twoFactorBackupCodes'>;
};

export const validateTwoFactorAuthentication = async ({
  backupCode,
  totpCode,
  user,
}: ValidateTwoFactorAuthenticationOptions) => {
  if (!user.twoFactorEnabled) {
    throw new AppError(AppErrorCode.TWO_FACTOR_SETUP_REQUIRED);
  }

  if (!user.twoFactorSecret) {
    throw new AppError(AppErrorCode.TWO_FACTOR_MISSING_SECRET);
  }

  if (totpCode) {
    return await verifyTwoFactorAuthenticationToken({ user, totpCode });
  }

  // Solid Ten Sign: a backup code is used up when it is accepted.
  if (backupCode) {
    return await consumeBackupCode({ user, backupCode });
  }

  throw new AppError(AppErrorCode.TWO_FACTOR_MISSING_CREDENTIALS);
};
