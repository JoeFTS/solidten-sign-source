import { AppError, AppErrorCode } from '../../errors/app-error';
import { getInPersonLockId } from './in-person-lock';

/**
 * Refuse a request made with a sign-in that is handed to signers for in-person
 * signing. The host gets it back by exiting in-person mode with their PIN.
 *
 * Costs nothing for ordinary sign-ins: the marker is on the session row that
 * was already loaded.
 */
export const assertNotInPersonLocked = async (session: { id: string; stInPersonSessionId?: string | null }) => {
  if (!session.stInPersonSessionId) {
    return;
  }

  const lockId = await getInPersonLockId(session);

  if (lockId) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: 'In-person signing is running on this device. Exit in-person signing first.',
      statusCode: 403,
    });
  }
};
