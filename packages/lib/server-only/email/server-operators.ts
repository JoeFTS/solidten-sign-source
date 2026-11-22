import { prisma } from '@documenso/prisma';
import { Role } from '@prisma/client';

import { env } from '../../utils/env';
import { zEmail } from '../../utils/zod';
import { withoutServiceAccounts } from './deliverable-recipients';

/**
 * Solid Ten Sign (RT3-M1): who hears about server-wide events (a daily cap reached).
 *
 * NEXT_PRIVATE_ST_OPERATOR_EMAILS, a comma list, when set. Otherwise the users with the
 * instance ADMIN role who are not disabled. Never every organisation owner (every user owns a
 * personal organisation), never the service accounts.
 */
export const parseOperatorEmails = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => zEmail().safeParse(email).success);

export const getServerOperatorRecipients = async (): Promise<{ name: string; address: string }[]> => {
  const configured = parseOperatorEmails(env('NEXT_PRIVATE_ST_OPERATOR_EMAILS'));

  if (configured.length > 0) {
    return withoutServiceAccounts(configured.map((address) => ({ name: '', address })));
  }

  const admins = await prisma.user.findMany({
    where: { roles: { has: Role.ADMIN }, disabled: false },
    select: { email: true, name: true },
  });

  return withoutServiceAccounts(admins.map((admin) => ({ name: admin.name ?? '', address: admin.email })));
};
