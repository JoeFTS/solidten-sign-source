import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '../constants/direct-templates';

// The same as TEMPLATE_RECIPIENT_*_PLACEHOLDER_REGEX in constants/template.ts. Copied: that file
// imports lingui macros, which server code outside the app build (tests, jobs) cannot load.
const TEMPLATE_RECIPIENT_EMAIL_PLACEHOLDER_REGEX = /recipient\.\d+@documenso\.com/i;
const TEMPLATE_RECIPIENT_NAME_PLACEHOLDER_REGEX = /Recipient \d+/i;

/**
 * Solid Ten Sign (N-1): a signer as the sender knows them. The direct-link signer carries a
 * placeholder address that nobody should read, so it is named by its role.
 */
export const describeSignerForSender = (recipient: { email: string; name?: string | null }) => {
  if (recipient.email.toLowerCase() === DIRECT_TEMPLATE_RECIPIENT_EMAIL) {
    return 'The direct link signer';
  }

  // Solid Ten Sign (O-F3): a template's placeholder ("Recipient 1", recipient.1@documenso.com) is
  // a position, not a name the sender gave; it reads like an internal number.
  const name =
    recipient.name && !TEMPLATE_RECIPIENT_NAME_PLACEHOLDER_REGEX.test(recipient.name) ? recipient.name : null;
  const email =
    recipient.email && !TEMPLATE_RECIPIENT_EMAIL_PLACEHOLDER_REGEX.test(recipient.email) ? recipient.email : null;

  return name || email || 'A signer with no name or email yet';
};
