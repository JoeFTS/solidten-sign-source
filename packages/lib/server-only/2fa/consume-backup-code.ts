import { prisma } from '@documenso/prisma';
import type { User } from '@prisma/client';

import { DOCUMENSO_ENCRYPTION_KEY } from '../../constants/crypto';
import { symmetricEncrypt } from '../../universal/crypto';
import { getBackupCodes } from './get-backup-code';

/**
 * Solid Ten Sign: a backup code works once. When the code matches, it is removed from the
 * user's list in a conditional update on the stored ciphertext, so two requests with the
 * same code cannot both succeed. Returns whether this request used the code.
 */
export const consumeBackupCode = async ({
  user,
  backupCode,
}: {
  user: Pick<User, 'id' | 'twoFactorEnabled' | 'twoFactorBackupCodes'>;
  backupCode: string;
}) => {
  const codes = getBackupCodes({ user });

  if (!codes || !user.twoFactorBackupCodes) {
    throw new Error('User has no backup codes');
  }

  const index = codes.indexOf(backupCode);

  if (index === -1) {
    return false;
  }

  const key = DOCUMENSO_ENCRYPTION_KEY;

  if (!key) {
    throw new Error('Missing DOCUMENSO_ENCRYPTION_KEY');
  }

  const remaining = codes.filter((_, i) => i !== index);

  const { count } = await prisma.user.updateMany({
    where: { id: user.id, twoFactorBackupCodes: user.twoFactorBackupCodes },
    data: { twoFactorBackupCodes: symmetricEncrypt({ key, data: JSON.stringify(remaining) }) },
  });

  return count === 1;
};
