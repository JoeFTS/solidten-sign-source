import { prisma } from '@documenso/prisma';

/**
 * Solid Ten (AUD-10): whether the signed-in account is the recipient (same email, any case).
 *
 * A PASSWORD, PASSKEY or authenticator-app step-up proves only that the signed-in account holds its
 * own credential. It is recorded as the recipient's re-authentication, so the account must be the
 * recipient's, as the ACCOUNT method already requires.
 */
export const isSessionUserTheRecipient = async ({
  userId,
  recipientEmail,
}: {
  userId: number;
  recipientEmail: string;
}) => {
  const user = await prisma.user.findFirst({ where: { id: userId }, select: { email: true } });

  return Boolean(user) && user?.email.trim().toLowerCase() === recipientEmail.trim().toLowerCase();
};
