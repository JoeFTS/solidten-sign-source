import { msg } from '@lingui/core/macro';

import { NEXT_PUBLIC_ST_SOURCE_URL } from '../source-code';
import type { HelpFaqCategory, HelpFaqEntry } from './types';

/**
 * Solid Ten Sign: the questions on /help/faq. Same word rules as topics.ts. For legal questions we
 * say what the product records and send the reader to their own lawyer. We give no legal advice.
 */

export const HELP_SUPPORT_EMAIL = 'support@solidten.io';

export const HELP_FAQ_CATEGORIES: HelpFaqCategory[] = [
  { id: 'signing', title: msg`Signing` },
  { id: 'legal-and-proof', title: msg`Legal questions and proof` },
  { id: 'security-and-privacy', title: msg`Security and privacy` },
  { id: 'documents-and-limits', title: msg`Documents and limits` },
  { id: 'account-and-support', title: msg`Your account and support` },
];

export const HELP_FAQ: HelpFaqEntry[] = [
  // Signing.
  {
    id: 'what-does-a-signer-need',
    category: 'signing',
    question: msg`What does a signer need?`,
    answer: msg`An email address and a computer or phone with an up-to-date browser. The signer needs no account, no password and no app.`,
    relatedSlug: 'no-account-needed',
  },
  {
    id: 'lost-link',
    category: 'signing',
    question: msg`I cannot find my signing link. What do I do?`,
    answer: msg`Search your email for "Solid Ten Sign" or for the sender's name, and check your spam folder. The button in that email is your link. If you still cannot find it, ask the sender to send it again.`,
    relatedSlug: 'resend-the-request',
  },
  {
    id: 'no-signing-email',
    category: 'signing',
    question: msg`Someone sent me a document, but no email arrived.`,
    answer: msg`Check your spam or junk folder first. Then ask the sender to check your email address. The sender can send the request again, or pass it to your right address.`,
    relatedSlug: 'correct-a-signers-email',
  },
  {
    id: 'expired-link',
    category: 'signing',
    question: msg`My link says "Signing Deadline Expired".`,
    answer: msg`The sender set a deadline and it has passed. Ask the sender for a new request. The sender can send the document again with a new deadline.`,
    relatedSlug: 'reminders-and-expiry',
  },
  {
    id: 'not-your-turn',
    category: 'signing',
    question: msg`The page says "Waiting for Your Turn".`,
    answer: msg`The sender chose an order, and someone before you has not signed yet. You get an email when it is your turn. You do not need to do anything now.`,
    relatedSlug: 'add-signers-and-signing-order',
  },
  {
    id: 'wrong-person',
    category: 'signing',
    question: msg`The request came to me, but someone else should sign.`,
    answer: msg`If the sender allows it, select "Reassign" on the signing page and type the right person's name and email. If you do not see "Reassign", tell the sender. Do not forward the email: anyone with your link can act as you.`,
    relatedSlug: 'reassign-to-someone-else',
  },
  {
    id: 'change-after-signing',
    category: 'signing',
    question: msg`Can I change something after I signed?`,
    answer: msg`No. A completed signature cannot be changed. Ask the sender to cancel the document and send a corrected copy.`,
    relatedSlug: 'cancel-a-document',
  },
  {
    id: 'sign-on-a-phone',
    category: 'signing',
    question: msg`Can I sign on my phone?`,
    answer: msg`Yes. Open the email on your phone and select the button. On a small screen, the "Actions" menu at the top holds "Reject", "Reassign" and the other actions.`,
    relatedSlug: 'how-to-sign',
  },
  {
    id: 'who-gets-a-copy',
    category: 'signing',
    question: msg`Who gets the signed copy, and when?`,
    answer: msg`When everyone has signed, each party gets an email with the signed PDF. A large file comes as a download link instead. A visitor on a shared link whose email address was not checked by a code gets no email, and can download the copy on the page.`,
    relatedSlug: 'download-the-signed-copy',
  },
  {
    id: 'text-messages',
    category: 'signing',
    question: msg`Can you send the signing request by text message?`,
    answer: msg`No. Solid Ten Sign sends requests by email, or the sender shares a link with you another way.`,
    relatedSlug: 'send-links-yourself',
  },

  // Legal questions and proof.
  {
    id: 'is-it-legally-valid',
    category: 'legal-and-proof',
    question: msg`Is an electronic signature legally valid?`,
    answer: msg`In many places electronic signatures are accepted for many kinds of documents, but the rules differ by place and by document. Solid Ten Sign records the signer's consent to sign electronically, the signature, the time, the IP address and the device, and it seals the signed PDF. We do not give legal advice. Ask your lawyer whether an electronic signature fits your document.`,
    relatedSlug: 'the-certificate-and-audit-log',
  },
  {
    id: 'what-the-certificate-shows',
    category: 'legal-and-proof',
    question: msg`What does the certificate show?`,
    answer: msg`For each recipient it shows the name and email address, when they viewed and signed, the IP address, the device and browser, and the access check they passed. It also lists a fingerprint of each file a signer attached.`,
    relatedSlug: 'the-certificate-and-audit-log',
  },
  {
    id: 'what-the-audit-log-shows',
    category: 'legal-and-proof',
    question: msg`What is in the audit log?`,
    answer: msg`Every step of the document with its time: created, sent, opened, each field filled, signed, rejected, canceled, reassigned, comments and downloads of attached files. The sender can download it as a PDF.`,
    relatedSlug: 'the-certificate-and-audit-log',
  },
  {
    id: 'can-the-pdf-be-changed',
    category: 'legal-and-proof',
    question: msg`Can someone change the signed PDF without anyone knowing?`,
    answer: msg`The signed PDF carries a digital seal over the whole document. If anyone changes the file after it was sealed, a PDF reader shows that the seal is no longer valid. Your PDF reader may say that it does not know who issued the seal. That message is about the issuer, not about changes to the file.`,
  },
  {
    id: 'how-do-you-know-who-signed',
    category: 'legal-and-proof',
    question: msg`How do you know who signed?`,
    answer: msg`The request goes to one email address, and only the person with that email can open the link. The sender can also ask for a 6-digit code that we email before the signer completes. Solid Ten Sign does not check photo ID.`,
    relatedSlug: 'signer-identity-check',
  },
  {
    id: 'consent-to-sign-electronically',
    category: 'legal-and-proof',
    question: msg`Where is the consent to sign electronically?`,
    answer: msg`Before the signer completes, the confirmation box says that the electronic signature will be used to sign the document. The full text is on the page "signature disclosure", linked from that box.`,
    relatedSlug: 'how-to-sign',
    link: { label: msg`Read the signature disclosure`, href: () => '/articles/signature-disclosure' },
  },

  // Security and privacy.
  {
    id: 'who-can-see-a-document',
    category: 'security-and-privacy',
    question: msg`Who can see my document?`,
    answer: msg`The owner and the recipients of the document. In a team, the document's visibility decides which team members can also see it: everyone, managers and admins, or admins only.`,
    relatedSlug: 'document-defaults',
  },
  {
    id: 'where-are-documents-stored',
    category: 'security-and-privacy',
    question: msg`Where are the documents stored?`,
    answer: msg`On the Solid Ten Sign server that Solid Ten runs. Signed documents stay there until the owner deletes them or a retention rule removes them.`,
    relatedSlug: 'retention',
  },
  {
    id: 'is-my-link-private',
    category: 'security-and-privacy',
    question: msg`Is my signing link private?`,
    answer: msg`Yes, and keep it that way. The link belongs to you. Anyone who has it can open the document and act as you, so do not forward the email.`,
    relatedSlug: 'reassign-to-someone-else',
  },
  {
    id: 'is-this-email-real',
    category: 'security-and-privacy',
    question: msg`How do I know a signing email is real?`,
    answer: msg`The email comes from Solid Ten Sign and names the sender. The button opens a page on sign.solidten.io. If you did not expect the document, ask the sender by phone or by a separate email before you sign.`,
  },
  {
    id: 'passwords',
    category: 'security-and-privacy',
    question: msg`Do I need a password?`,
    answer: msg`No. Signers use the link in their email. Staff sign in with a link that we email to them. You can add two-factor authentication to your staff account.`,
    relatedSlug: 'account-security',
  },

  // Documents and limits.
  {
    id: 'supported-files',
    category: 'documents-and-limits',
    question: msg`Which files can I upload?`,
    answer: msg`PDF files only. Save a Word document or a scan as a PDF first.`,
    relatedSlug: 'upload-and-send',
  },
  {
    id: 'file-size-limit',
    category: 'documents-and-limits',
    question: msg`How large can a PDF be?`,
    answer: msg`Up to 5 MB for each PDF. If your file is larger, save it again at a smaller size, scan it in black and white, or split it into several PDFs in one document.`,
    relatedSlug: 'add-several-files',
  },
  {
    id: 'document-limit',
    category: 'documents-and-limits',
    question: msg`How many documents can I send?`,
    answer: msg`Solid Ten Sign does not limit the number of documents you send.`,
  },
  {
    id: 'change-a-sent-document',
    category: 'documents-and-limits',
    question: msg`Can I change a document after I sent it?`,
    answer: msg`The PDF cannot change after it is sent. You can still send reminders and pass a request to another person. For other changes, cancel the document, then copy it with "Duplicate", fix the copy and send it.`,
    relatedSlug: 'duplicate-and-save-as-template',
  },
  {
    id: 'how-long-are-documents-kept',
    category: 'documents-and-limits',
    question: msg`How long are documents kept?`,
    answer: msg`Until the owner deletes them. A team admin can set a retention rule that deletes finished documents after a set number of days. The rule is off unless an admin turns it on.`,
    relatedSlug: 'retention',
  },
  {
    id: 'deleted-by-mistake',
    category: 'documents-and-limits',
    question: msg`I deleted a document by mistake.`,
    answer: msg`You cannot undo a delete yourself. Email support@solidten.io with the document title and the date you sent it. We check what can be done.`,
    relatedSlug: 'delete-a-document',
  },
  {
    id: 'languages',
    category: 'documents-and-limits',
    question: msg`Which languages does Solid Ten Sign speak?`,
    answer: msg`The signing page uses the language of the signer's browser. The emails and the certificate use the language set on the document.`,
    relatedSlug: 'document-defaults',
  },
  {
    id: 'several-pdfs',
    category: 'documents-and-limits',
    question: msg`Can one request hold more than one PDF?`,
    answer: msg`Yes. Add more PDFs on "Document & Recipients". The signer signs all of them in one visit.`,
    relatedSlug: 'add-several-files',
  },

  // Your account and support.
  {
    id: 'get-an-account',
    category: 'account-and-support',
    question: msg`How do I get an account?`,
    answer: msg`Accounts are for staff of the teams that use Solid Ten Sign. Nobody can sign up on their own: ask your administrator to create your account. Signers do not need an account.`,
    relatedSlug: 'team-members',
  },
  {
    id: 'no-sign-in-email',
    category: 'account-and-support',
    question: msg`I asked for a sign-in link, but no email came.`,
    answer: msg`Check your spam folder, and check that you typed the address of your account. Wait a few minutes and ask for a new link. Each link works one time and expires after 15 minutes.`,
    relatedSlug: 'sign-in-with-emailed-link',
  },
  {
    id: 'lost-authenticator',
    category: 'account-and-support',
    question: msg`I lost the phone with my authenticator app.`,
    answer: msg`Sign in with one of your backup codes: select "Use a backup code". If you have no backup codes, ask your administrator to reset two-factor authentication on your account.`,
    relatedSlug: 'account-security',
  },
  {
    id: 'source-code',
    category: 'account-and-support',
    question: msg`Where is the source code of Solid Ten Sign?`,
    answer: msg`Solid Ten Sign is open source under the AGPL-3.0 license. Anyone who uses the service can get the source code of the version that runs here.`,
    link: { label: msg`Source code`, href: () => NEXT_PUBLIC_ST_SOURCE_URL() },
  },
  {
    id: 'contact-support',
    category: 'account-and-support',
    question: msg`Who do I contact for help?`,
    answer: msg`Signers: for questions about the document itself, contact the person who sent it. For problems with Solid Ten Sign, email support@solidten.io.`,
    link: { label: msg`Email support@solidten.io`, href: () => `mailto:${HELP_SUPPORT_EMAIL}` },
  },
];
