import { deletedServiceAccountEmail } from '../user/service-accounts/deleted-account';
import { legacyServiceAccountEmail } from '../user/service-accounts/legacy-service-account';

/**
 * Solid Ten Sign (RT3-M1): the built-in service accounts cannot receive mail. A message to
 * them only sits in email retry for hours, so no email of ours ever goes to them.
 */
const getServiceAccountEmails = () =>
  new Set(
    [
      legacyServiceAccountEmail(),
      deletedServiceAccountEmail(),
      'serviceaccount@documenso.com',
      'deleted-account@documenso.com',
    ].map((email) => email.trim().toLowerCase()),
  );

export const isServiceAccountEmail = (email: string, serviceAccounts = getServiceAccountEmails()) =>
  serviceAccounts.has(email.trim().toLowerCase());

export const withoutServiceAccounts = <T extends { address: string }>(recipients: T[]): T[] => {
  const serviceAccounts = getServiceAccountEmails();

  return recipients.filter((recipient) => !isServiceAccountEmail(recipient.address, serviceAccounts));
};
