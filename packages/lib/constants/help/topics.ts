import { msg } from '@lingui/core/macro';

import type { HelpCategory, HelpTopic, HelpVideo } from './types';

/**
 * Solid Ten Sign: the help articles, one per function. This file is the source of truth for the
 * help pages and for the walkthrough videos (the video team reads the exported topics.json).
 *
 * Rules for the words (see docs/brand/README.md in the company repo):
 * - One action per step. On-screen labels in double quotes, exactly as the screen shows them.
 * - Only what this server does today: sign-in by emailed link, sign-up closed, PDF uploads up to
 *   5 MB, no text messages.
 * - No vendor names, no legal advice.
 */

/**
 * The video of a topic: `<slug>.mp4` and `<slug>.jpg` under the help media base. Set it only when
 * the file is rendered and served; a topic with `video: null` requests no media at all. The video
 * team names new files after the slug and asks for the topic to be switched on here.
 */
const video = (slug: string, seconds: number): HelpVideo => ({
  file: `${slug}.mp4`,
  poster: `${slug}.jpg`,
  seconds,
});

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: 'getting-started',
    title: msg`Getting started`,
    description: msg`Sign in and find your way around.`,
  },
  {
    id: 'sending',
    title: msg`Send a document`,
    description: msg`Upload a PDF, add the people who sign, place the fields and send.`,
  },
  {
    id: 'templates',
    title: msg`Templates, links and forms`,
    description: msg`Reuse a document, send many at once, or share one link.`,
  },
  {
    id: 'signers',
    title: msg`For signers`,
    description: msg`You got a signing request by email. Here is how to sign.`,
  },
  {
    id: 'after-sending',
    title: msg`After sending`,
    description: msg`Follow a document, fix problems and keep the signed copy.`,
  },
  {
    id: 'settings',
    title: msg`Team and settings`,
    description: msg`Your profile, your team, defaults and connections to other tools.`,
  },
];

export const HELP_TOPICS: HelpTopic[] = [
  // Getting started.
  {
    slug: 'sign-in-with-emailed-link',
    category: 'getting-started',
    audience: 'sender',
    title: msg`Sign in with an emailed link`,
    summary: msg`Solid Ten Sign has no password for staff. You type your email address and we email you a link that signs you in.`,
    steps: [
      { text: msg`Open the sign-in page and type your email address in "Email".` },
      {
        text: msg`Select "Email me a sign-in link".`,
        tip: msg`The page says "Check your email". If you typed the wrong address, select "Use a different email".`,
      },
      {
        text: msg`Open the email "Your sign-in link" and select "Sign in".`,
        tip: msg`The link works one time and expires in 15 minutes.`,
      },
      { text: msg`On the page "Finish signing in", select "Sign in".` },
      {
        text: msg`If your account uses two-factor authentication, type the code from your authenticator app and select "Sign in".`,
        tip: msg`No phone with you? Select "Use a backup code" and type one of your backup codes.`,
      },
    ],
    related: ['your-documents-page', 'account-security'],
    video: null,
  },
  {
    slug: 'your-documents-page',
    category: 'getting-started',
    audience: 'sender',
    title: msg`Find your way around the documents page`,
    summary: msg`The documents page lists every document you sent or received. Filter it by status, date and sender.`,
    steps: [
      { text: msg`Select "Documents" at the top of the page.` },
      {
        text: msg`Select "Status" and choose a status, for example "Pending".`,
        tip: msg`"Draft" is not sent yet. "Pending" waits for signatures. "Completed" is signed by everyone. "Inbox" holds documents others sent to you.`,
      },
      { text: msg`Type part of a title in "Search documents..." to find one document.` },
      { text: msg`Select "Period" to show only the last 7, 14 or 30 days.` },
      { text: msg`Select "Sender" to show only the documents of some team members.` },
      { text: msg`Select a row to open the page of that document.` },
      {
        text: msg`Select the three-dot menu at the end of a row to see what you can do, for example "Download" or "Duplicate".`,
      },
    ],
    related: ['folders', 'track-status', 'upload-and-send'],
    video: null,
  },
  {
    slug: 'folders',
    category: 'getting-started',
    audience: 'sender',
    title: msg`Put documents in folders`,
    summary: msg`Folders keep the documents of one client or one project together. Templates can have folders too.`,
    steps: [
      { text: msg`On the documents page, select "Create Folder".` },
      { text: msg`Type a name in "Folder Name" and select "Create".` },
      { text: msg`Open the three-dot menu of a document and select "Move to Folder".` },
      { text: msg`Choose the folder and select "Move".` },
      {
        text: msg`Select the folder under "Folders" to see what is in it.`,
        tip: msg`Use the menu of a folder to "Pin" it at the front, or to move or delete it.`,
      },
    ],
    related: ['your-documents-page'],
    video: null,
  },

  // Send a document.
  {
    slug: 'upload-and-send',
    category: 'sending',
    audience: 'sender',
    title: msg`Upload a PDF and send it for signature`,
    summary: msg`The main job: upload a PDF, say who signs, place a signature field and send the request by email.`,
    steps: [
      {
        text: msg`On the documents page, select "Upload Document" and choose a PDF file.`,
        tip: msg`You can also drag the PDF onto the page. Only PDF files are accepted, up to 5 MB each.`,
      },
      { text: msg`On "Document & Recipients", type the signer's "Email" and "Name".` },
      { text: msg`Select "Add Fields".` },
      { text: msg`Drag a "Signature" field onto the place where the signer signs.` },
      {
        text: msg`Select "Send Document".`,
        tip: msg`If a signer has no signature field, the dialog tells you before anything is sent.`,
      },
      {
        text: msg`Keep "Email" selected and select "Send".`,
        tip: msg`Each signer gets an email with the button "View Document to sign".`,
      },
    ],
    related: ['add-signers-and-signing-order', 'place-fields', 'message-and-subject', 'track-status'],
    video: video('upload-and-send', 35),
  },
  {
    slug: 'add-several-files',
    category: 'sending',
    audience: 'sender',
    title: msg`Send several PDFs in one document`,
    summary: msg`One request can hold more than one PDF. The signer signs all of them in one visit.`,
    steps: [
      { text: msg`Upload the first PDF as usual.` },
      { text: msg`On "Document & Recipients", find the "Documents" box.` },
      {
        text: msg`Drag the next PDF into the box, or select the box and choose the file.`,
        tip: msg`Each PDF can be up to 5 MB.`,
      },
      { text: msg`Change a file name in "Document Title" if you want.` },
      {
        text: msg`Select "Add Fields" and choose each file at the top to place its fields.`,
      },
    ],
    related: ['upload-and-send', 'place-fields'],
    video: null,
  },
  {
    slug: 'add-signers-and-signing-order',
    category: 'sending',
    audience: 'sender',
    title: msg`Add signers and set the signing order`,
    summary: msg`Add everyone who must act on the document. You can let them sign in any order or one after the other.`,
    steps: [
      {
        text: msg`On "Document & Recipients", select "Add Signer" for each person.`,
        tip: msg`Select "Add Myself" to add yourself.`,
      },
      { text: msg`Type each person's "Email" and "Name".` },
      { text: msg`Select "Show advanced settings".` },
      {
        text: msg`Turn on "Enable signing order".`,
        tip: msg`You need 2 or more signers for this. The next person gets the email only after the person before them has signed.`,
      },
      { text: msg`Drag the people into the order in which they sign.` },
      {
        text: msg`To let each signer choose who signs next, turn on "Allow signers to dictate next signer".`,
      },
    ],
    related: ['recipient-roles', 'upload-and-send'],
    video: null,
  },
  {
    slug: 'recipient-roles',
    category: 'sending',
    audience: 'sender',
    title: msg`Choose what each recipient does`,
    summary: msg`Not everyone signs. Some people approve, some only look, and some get a copy at the end.`,
    steps: [
      { text: msg`On "Document & Recipients", open the role menu next to a recipient.` },
      { text: msg`Choose "Needs to sign" for a person who signs.` },
      { text: msg`Choose "Needs to approve" for a person who approves the document without a signature.` },
      { text: msg`Choose "Needs to view" for a person who must open and read the document.` },
      { text: msg`Choose "Receives copy" for a person who gets the signed copy when everyone is done.` },
      {
        text: msg`Choose "Can prepare" for a person who fills in fields for the signers after them.`,
        tip: msg`"Can prepare" works only with "Enable signing order" turned on, and not as the last person.`,
      },
    ],
    related: ['add-signers-and-signing-order', 'place-fields'],
    video: null,
  },
  {
    slug: 'place-fields',
    category: 'sending',
    audience: 'sender',
    title: msg`Place fields on the document`,
    summary: msg`Fields show the signer where to sign and what to fill in. Each field belongs to one recipient.`,
    steps: [
      { text: msg`Select "Add Fields".` },
      { text: msg`Under "Selected Recipient", choose the person the next fields are for.` },
      {
        text: msg`Drag a field type onto the page.`,
        tip: msg`The types are "Signature", "Initials", "Name", "Email", "Date", "Text", "Number", "Radio", "Checkbox", "Dropdown" and "Attach a file".`,
      },
      { text: msg`Drag the field to move it. Drag its edge to make it bigger or smaller.` },
      { text: msg`Select the field to open its settings, for example "Text Settings".` },
      {
        text: msg`To copy a field, select it and choose "Duplicate". To delete it, choose "Remove".`,
        tip: msg`If two fields lie on top of each other, the editor shows "Overlapping fields detected".`,
      },
      { text: msg`Select "Preview" to see the document as the signer will see it.` },
    ],
    related: ['required-and-prefilled-fields', 'conditional-fields', 'calculated-fields', 'attach-a-file-field'],
    video: null,
  },
  {
    slug: 'required-and-prefilled-fields',
    category: 'sending',
    audience: 'sender',
    title: msg`Make a field required, read-only or filled in`,
    summary: msg`Decide which fields the signer must fill, and give fields a value before you send.`,
    steps: [
      { text: msg`On "Add Fields", select a field.` },
      { text: msg`Turn on "Required Field" if the signer must fill it.` },
      {
        text: msg`For a "Text" field, type the value in "Add text". For a "Number" field, type it in "Value".`,
        tip: msg`For a "Dropdown", choose the "Default Value". For a "Radio" field, choose the "Default value".`,
      },
      { text: msg`Turn on "Read Only" so the signer sees the value and cannot change it.` },
      { text: msg`Type a "Label" or a "Placeholder" to tell the signer what to enter.` },
      {
        text: msg`Set limits if you need them: "Character Limit" for text, "Min" and "Max" for numbers.`,
      },
    ],
    related: ['place-fields', 'conditional-fields'],
    video: null,
  },
  {
    slug: 'conditional-fields',
    category: 'sending',
    audience: 'sender',
    title: msg`Show a field only when another field has a value`,
    summary: msg`A rule can hide a field until the signer ticks a box or picks an option. Hidden fields stay out of the signed PDF.`,
    steps: [
      { text: msg`On "Add Fields", select the field that the rule looks at, for example a checkbox.` },
      { text: msg`Select "Set up rules".` },
      {
        text: msg`Type a short name in "Field key", for example deposit.`,
        tip: msg`Start with a letter. Use only letters, digits and underscores.`,
      },
      { text: msg`Select the field that must appear or hide, and select "Set up rules".` },
      { text: msg`Under "Show this field only when", choose the key you typed.` },
      {
        text: msg`Choose the test, for example "is checked", "equals" or "is not empty".`,
        tip: msg`While the rule is false, the signer does not see the field.`,
      },
      { text: msg`Select "Preview" and try the rule.` },
    ],
    related: ['calculated-fields', 'place-fields'],
    video: null,
  },
  {
    slug: 'calculated-fields',
    category: 'sending',
    audience: 'sender',
    title: msg`Calculate a number from other fields`,
    summary: msg`A number field can add, subtract, multiply or divide other number fields of the same signer, for example a total.`,
    steps: [
      { text: msg`Place the number fields that hold the inputs, for example price and quantity.` },
      { text: msg`Select each input field, select "Set up rules" and give it a "Field key".` },
      { text: msg`Place the "Number" field that shows the result.` },
      { text: msg`Select it and select "Set up rules".` },
      {
        text: msg`In "Formula", type the calculation with the keys in double curly brackets, for example price times quantity.`,
        tip: msg`You can use + - * /, brackets, SUM, MIN, MAX and ROUND.`,
      },
      {
        text: msg`Tick "Count empty fields as 0" if the total should show before every field is filled.`,
        tip: msg`The server checks the result again when the signer completes.`,
      },
    ],
    related: ['conditional-fields', 'place-fields'],
    video: null,
  },
  {
    slug: 'attach-a-file-field',
    category: 'sending',
    audience: 'sender',
    title: msg`Ask the signer to attach a file`,
    summary: msg`The "Attach a file" field asks the signer to upload a file, for example a copy of an insurance certificate.`,
    steps: [
      { text: msg`On "Add Fields", drag "Attach a file" onto the page.` },
      { text: msg`Select the field to open "Attach a File Settings".` },
      { text: msg`Set the "Number of files" the signer can attach.` },
      { text: msg`Choose the "Allowed file types", for example PDF, PNG or JPEG.` },
      {
        text: msg`Turn on "Visible to all recipients" if the other recipients may see the files.`,
      },
      {
        text: msg`After signing, find the files under "Attached files" on the document page.`,
        tip: msg`The certificate lists a fingerprint of each attached file, so a changed file can be detected.`,
      },
    ],
    related: ['attach-a-file-as-signer', 'place-fields'],
    video: null,
  },
  {
    slug: 'message-and-subject',
    category: 'sending',
    audience: 'sender',
    title: msg`Write the email subject and message`,
    summary: msg`Change the subject and the text of the email that asks people to sign.`,
    steps: [
      { text: msg`Select "Send Document".` },
      { text: msg`Type a "Subject (Optional)".` },
      { text: msg`Type a "Message (Optional)".` },
      {
        text: msg`Type a "Reply To Email (Optional)" if replies should go to another address.`,
      },
      {
        text: msg`Select "Send".`,
        tip: msg`You can also set these before you send: select "Document Settings" and open "Notifications".`,
      },
    ],
    related: ['upload-and-send', 'email-settings'],
    video: null,
  },
  {
    slug: 'schedule-send',
    category: 'sending',
    audience: 'sender',
    title: msg`Send a document later`,
    summary: msg`Choose a date and time. The document stays a draft until then and goes out by itself.`,
    steps: [
      { text: msg`Select "Send Document".` },
      { text: msg`Turn on "Send later".` },
      {
        text: msg`Choose the date and time in "Send on".`,
        tip: msg`The page shows the time zone it uses.`,
      },
      { text: msg`Select "Schedule".` },
      {
        text: msg`To stop it, select the "Scheduled" badge and then "Cancel schedule".`,
        tip: msg`You can keep editing the document until it is sent.`,
      },
    ],
    related: ['reminders-and-expiry', 'upload-and-send'],
    video: null,
  },
  {
    slug: 'reminders-and-expiry',
    category: 'sending',
    audience: 'sender',
    title: msg`Set reminders and a signing deadline`,
    summary: msg`Reminder emails go to people who have not signed yet. A deadline closes the link after a set time.`,
    steps: [
      { text: msg`In the editor, select "Document Settings".` },
      {
        text: msg`On "General", choose how long people have in "Expiration".`,
        tip: msg`After the deadline the link shows "Signing Deadline Expired". The owner and the signer each get an email.`,
      },
      { text: msg`Open "Reminders".` },
      { text: msg`Under "Signing Reminders", set "Send first reminder after".` },
      { text: msg`Set "Then repeat every", or choose "Don't repeat".` },
      { text: msg`Select "Update".` },
    ],
    related: ['schedule-send', 'resend-the-request', 'document-defaults'],
    video: null,
  },
  {
    slug: 'signer-identity-check',
    category: 'sending',
    audience: 'sender',
    title: msg`Ask signers for an emailed code`,
    summary: msg`For important documents, ask each signer for a 6-digit code that we email to them before they can complete.`,
    steps: [
      { text: msg`In the editor, select "Document Settings".` },
      { text: msg`Open "Security".` },
      { text: msg`In "Document access", choose "Require 2FA".` },
      {
        text: msg`Select "Update".`,
        tip: msg`When the signer completes, we email a 6-digit code. Five wrong codes lock the code until the signer asks for a new one.`,
      },
      {
        text: msg`Use "Require account" only for people who have an account on Solid Ten Sign, such as your staff.`,
        tip: msg`Outside signers cannot create an account here, so they could not open the document.`,
      },
    ],
    related: ['enter-the-emailed-code', 'the-certificate-and-audit-log'],
    video: null,
  },
  {
    slug: 'send-links-yourself',
    category: 'sending',
    audience: 'sender',
    title: msg`Get the signing links and send them yourself`,
    summary: msg`If you do not want us to email the request, we make a link for each signer that you send any way you like.`,
    steps: [
      { text: msg`Select "Send Document".` },
      {
        text: msg`Choose "None" instead of "Email".`,
        tip: msg`We will not send anything to the recipients.`,
      },
      { text: msg`Select "Generate Links".` },
      { text: msg`Copy each signer's link and send it to that person only.` },
      {
        text: msg`To copy the links again later, open the document page and select "Copy Signing Links" in "Recipients".`,
        tip: msg`Each link belongs to one person. Anyone who has the link can act as that person.`,
      },
    ],
    related: ['upload-and-send', 'in-person-signing'],
    video: null,
  },
  {
    slug: 'in-person-signing',
    category: 'sending',
    audience: 'sender',
    title: msg`Sign in person on one device`,
    summary: msg`When the signers are with you, hand them your device. Each one confirms their name and signs. No signing emails go to them.`,
    steps: [
      { text: msg`Send the document, then open its page.` },
      { text: msg`In "Sign in person", select "Sign in person".` },
      {
        text: msg`Choose the signers who are with you.`,
        tip: msg`Turn on "Ask for a code sent to their email" for a signer who has their phone.`,
      },
      { text: msg`Type a PIN in "Your PIN (4 to 8 digits)" and again in "Repeat the PIN".` },
      { text: msg`Select "Start in-person signing".` },
      { text: msg`Select "Hand over to sign" next to a signer and give them the device.` },
      { text: msg`The signer types their name, selects "Confirm and continue" and signs.` },
      {
        text: msg`Take the device back, type your PIN and select "Unlock".`,
        tip: msg`Forgot the PIN? End in-person signing from the document page on another device.`,
      },
      { text: msg`When everyone is done, select "Exit in-person signing".` },
    ],
    related: ['how-to-sign', 'document-lifecycle'],
    video: null,
  },

  // Templates, links and forms.
  {
    slug: 'create-a-template',
    category: 'templates',
    audience: 'sender',
    title: msg`Make a template`,
    summary: msg`A template keeps a document, its recipients and its fields, so you can send it again in a few clicks.`,
    steps: [
      { text: msg`Select "Templates" at the top of the page.` },
      { text: msg`Select "Upload Template" and choose a PDF file.` },
      {
        text: msg`Add the recipients and choose their roles.`,
        tip: msg`You can change the names and email addresses each time you use the template.`,
      },
      { text: msg`Select "Add Fields" and place the fields.` },
      {
        text: msg`Select "Return to templates".`,
        tip: msg`The editor saves your changes as you work.`,
      },
    ],
    related: ['send-from-a-template', 'duplicate-and-save-as-template', 'direct-links'],
    video: null,
  },
  {
    slug: 'send-from-a-template',
    category: 'templates',
    audience: 'sender',
    title: msg`Send a document from a template`,
    summary: msg`Create a new document from a template and fill in the people who sign this time.`,
    steps: [
      { text: msg`Select "Templates".` },
      { text: msg`Select "Use Template" next to the template.` },
      { text: msg`Type the "Email" and "Name" of each recipient.` },
      {
        text: msg`Tick "Send document" to send it now.`,
        tip: msg`Leave it off to create a draft that you can check first.`,
      },
      { text: msg`Select "Create and send", or "Create as draft".` },
    ],
    related: ['create-a-template', 'bulk-send'],
    video: null,
  },
  {
    slug: 'bulk-send',
    category: 'templates',
    audience: 'sender',
    title: msg`Send one template to many people`,
    summary: msg`Upload a spreadsheet file (CSV) with one row per document. Each row becomes its own document.`,
    steps: [
      { text: msg`On "Templates", open the three-dot menu of the template.` },
      { text: msg`Select "Bulk Send via CSV".` },
      { text: msg`Select "Download Template CSV" and fill in one row for each document.` },
      {
        text: msg`Select "Upload CSV" and choose your file.`,
        tip: msg`Up to 100 rows and 4 MB per file. Empty cells use the template's values.`,
      },
      { text: msg`Turn on "Send documents to recipients immediately" if they should go out now.` },
      {
        text: msg`Select "Upload and Process".`,
        tip: msg`We email you when all documents are made.`,
      },
    ],
    related: ['send-from-a-template', 'create-a-template'],
    video: null,
  },
  {
    slug: 'direct-links',
    category: 'templates',
    audience: 'sender',
    title: msg`Share one signing link that anyone can open`,
    summary: msg`A direct link lets anyone who has it sign your template, for example a sign-up sheet on your website.`,
    steps: [
      { text: msg`On "Templates", open the three-dot menu of the template and select "Direct link".` },
      { text: msg`Select "Enable direct link signing".` },
      {
        text: msg`Choose the recipient that the visitor will be, or select "Create one automatically".`,
      },
      { text: msg`Select "Copy Shareable Link" and share the link.` },
      {
        text: msg`To stop the link, open the dialog again and turn off "Enable Direct Link Signing".`,
        tip: msg`A visitor whose email address is not checked by a code gets no email copy. They can download the copy on the page.`,
      },
    ],
    related: ['public-forms', 'sign-from-a-shared-link'],
    video: null,
  },
  {
    slug: 'public-forms',
    category: 'templates',
    audience: 'sender',
    title: msg`Run a public form with open and close dates`,
    summary: msg`A template with a direct link also works as a public form: set when it opens and closes, cap the responses and check each email address with a code.`,
    steps: [
      { text: msg`Turn on the direct link of the template.` },
      { text: msg`Open the template page. Find the "Public form" box.` },
      { text: msg`Select "Form settings".` },
      { text: msg`Set "Opens", "Closes" and "Maximum number of responses".` },
      { text: msg`Type an "Intro text" and a "Thank-you message".` },
      {
        text: msg`Turn on "Verify the email address with a code".`,
        tip: msg`Without it, nobody gets an email copy of the submitted document.`,
      },
      { text: msg`Select "Save".` },
      {
        text: msg`Follow the responses in the box. Select "Export CSV" for a list, or "Close form" to stop it.`,
        tip: msg`A public form cannot use "Attach a file" fields.`,
      },
    ],
    related: ['direct-links', 'fill-in-a-public-form'],
    video: null,
  },

  // For signers.
  {
    slug: 'how-to-sign',
    category: 'signers',
    audience: 'signer',
    title: msg`How to sign a document`,
    summary: msg`You got an email asking you to sign. You need no account and nothing to install.`,
    steps: [
      { text: msg`Open the email and select "View Document to sign".` },
      {
        text: msg`Read the document. The fields for you are marked on the page.`,
        tip: msg`The panel shows how many fields are left, for example "1 Field Remaining".`,
      },
      {
        text: msg`Select each field and fill it in.`,
        tip: msg`A signature field opens "Sign Signature Field". Choose "Draw", "Type" or "Upload", then select "Sign". A date field fills in by itself.`,
      },
      {
        text: msg`Select "Next Field" to jump to the next empty field.`,
      },
      {
        text: msg`When every field is filled, select "Complete".`,
        tip: msg`On a phone, the button is in the panel at the bottom of the screen.`,
      },
      {
        text: msg`In the box "Are you sure?", select "Sign".`,
        tip: msg`By signing you agree to sign electronically. Select "Read the full signature disclosure" to read the terms.`,
      },
      {
        text: msg`The page says "Document Signed". When everyone has signed, select "Download" and then "Signed" to keep a copy.`,
        tip: msg`You also get the signed copy by email.`,
      },
    ],
    related: ['adopt-a-signature', 'fill-in-fields', 'decline-to-sign', 'no-account-needed'],
    video: video('how-to-sign', 34),
  },
  {
    slug: 'adopt-a-signature',
    category: 'signers',
    audience: 'signer',
    title: msg`Draw, type or upload your signature`,
    summary: msg`Make your signature once. We put it in each signature field for you.`,
    steps: [
      { text: msg`Select a signature field.` },
      {
        text: msg`Choose "Draw" and sign with your mouse or finger.`,
        tip: msg`Select "Clear Signature" to start again, or "Undo" for the last stroke.`,
      },
      { text: msg`Or choose "Type" and type your name in "Type your signature".` },
      {
        text: msg`Or choose "Upload" and select "Upload Signature" to use a picture of your signature.`,
        tip: msg`The image must be smaller than 5 MB.`,
      },
      { text: msg`Select "Sign".` },
      { text: msg`For an initials field, type your initials in "Initials" and select "Enter".` },
    ],
    related: ['how-to-sign', 'fill-in-fields'],
    video: null,
  },
  {
    slug: 'fill-in-fields',
    category: 'signers',
    audience: 'signer',
    title: msg`Fill in dates, text, numbers and choices`,
    summary: msg`Besides your signature, the sender can ask for text, numbers, dates and choices.`,
    steps: [
      { text: msg`Select a text field, type in "Enter your text here" and select "Save".` },
      {
        text: msg`Select a number field, type in "Enter your number here" and select "Enter".`,
        tip: msg`If the number must have a format, the box says which one.`,
      },
      { text: msg`Select a checkbox or a radio button to choose it.` },
      { text: msg`Select a dropdown and choose an option.` },
      {
        text: msg`Select a date, name or email field. It fills in by itself, or asks you to type the value.`,
        tip: msg`Some fields appear only after you make a choice. That is on purpose.`,
      },
      { text: msg`A field with a value you cannot change was filled in by the sender.` },
    ],
    related: ['how-to-sign', 'attach-a-file-as-signer'],
    video: null,
  },
  {
    slug: 'enter-the-emailed-code',
    category: 'signers',
    audience: 'signer',
    title: msg`Enter the code we email you`,
    summary: msg`Some senders ask for a code before you complete. We email it to the address the request went to.`,
    steps: [
      { text: msg`Fill in the fields and select "Complete".` },
      { text: msg`In the box "Are you sure?", select "Sign".` },
      { text: msg`If the page asks "Choose verification method", choose "Email verification".` },
      { text: msg`Open the new email from Solid Ten Sign and copy the 6-digit code.` },
      {
        text: msg`Type the code under "Enter verification code" and select "Verify & Complete".`,
        tip: msg`The code expires. The box shows the time left.`,
      },
      {
        text: msg`No email? Check your spam folder, then select "Resend code".`,
        tip: msg`After five wrong codes the code is locked. Select "Resend code" to get a new one.`,
      },
    ],
    related: ['how-to-sign', 'signer-identity-check'],
    video: null,
  },
  {
    slug: 'decline-to-sign',
    category: 'signers',
    audience: 'signer',
    title: msg`Decline to sign (reject a document)`,
    summary: msg`If you do not agree with the document, reject it and tell the sender why.`,
    steps: [
      {
        text: msg`On a computer, select "Reject Document" under "Actions".`,
        tip: msg`On a phone, select "Actions" at the top and then "Reject".`,
      },
      { text: msg`Type a reason for the sender. It is optional.` },
      {
        text: msg`Select "Reject Document".`,
        tip: msg`This cannot be undone. If the sender asked for an emailed code, type the code first.`,
      },
      {
        text: msg`The page says "Document Rejected". The sender gets an email with your reason.`,
      },
    ],
    related: ['reassign-to-someone-else', 'ask-a-question'],
    video: null,
  },
  {
    slug: 'reassign-to-someone-else',
    category: 'signers',
    audience: 'signer',
    title: msg`Pass the request to the right person`,
    summary: msg`If you are not the person who should sign, pass the request on. The sender decides if this is allowed.`,
    steps: [
      {
        text: msg`On a computer, select "Reassign" under "Actions".`,
        tip: msg`On a phone, select "Actions" at the top and then "Reassign". If you do not see "Reassign", the sender has not allowed it: contact the sender.`,
      },
      { text: msg`Type the "Name" and "Email" of the right person.` },
      { text: msg`Type a "Reason (Optional)".` },
      {
        text: msg`Select "Reassign".`,
        tip: msg`Anything you filled in is removed. The new person gets their own link, and your link stops working.`,
      },
    ],
    related: ['decline-to-sign', 'correct-a-signers-email'],
    video: null,
  },
  {
    slug: 'ask-a-question',
    category: 'signers',
    audience: 'signer',
    title: msg`Ask the sender a question before you sign`,
    summary: msg`If the sender turned on comments, you can ask a question on the signing page and get the answer by email.`,
    steps: [
      {
        text: msg`Select "Questions and comments".`,
        tip: msg`On a phone, select "Actions" at the top first.`,
      },
      { text: msg`Type your question in "Your comment".` },
      { text: msg`Select "Send".` },
      {
        text: msg`When the sender's team replies, we email you. Open your signing link again to read the answer.`,
        tip: msg`Comments close when the document is completed, rejected or canceled.`,
      },
    ],
    related: ['comments', 'how-to-sign'],
    video: null,
  },
  {
    slug: 'attach-a-file-as-signer',
    category: 'signers',
    audience: 'signer',
    title: msg`Attach a file when you sign`,
    summary: msg`The sender can ask you for a file, for example a certificate or a photo of an ID.`,
    steps: [
      { text: msg`Select the field "Attach a file".` },
      {
        text: msg`Read which files are allowed and the largest size.`,
        tip: msg`The box says, for example, "Allowed: PDF, PNG, JPEG".`,
      },
      { text: msg`Select "Choose file" and pick the file.` },
      { text: msg`To add more files, select "Add another file".` },
      { text: msg`Select "Done".` },
    ],
    related: ['how-to-sign', 'fill-in-fields'],
    video: null,
  },
  {
    slug: 'sign-from-a-shared-link',
    category: 'signers',
    audience: 'signer',
    title: msg`Sign from a link on a website`,
    summary: msg`Some documents are shared as one link for everyone. You fill in the document and give your name and email address.`,
    steps: [
      { text: msg`Open the link.` },
      { text: msg`Fill in the fields and sign.` },
      { text: msg`Select "Complete".` },
      { text: msg`Type "Your Name" and "Your Email".` },
      {
        text: msg`Select "Sign".`,
        tip: msg`Your email address may not get a copy, because nobody checked it. Select "Download" on the next page to keep a copy.`,
      },
    ],
    related: ['fill-in-a-public-form', 'how-to-sign'],
    video: null,
  },
  {
    slug: 'fill-in-a-public-form',
    category: 'signers',
    audience: 'signer',
    title: msg`Fill in a public form`,
    summary: msg`A public form may first check your email address with a 6-digit code.`,
    steps: [
      { text: msg`Open the form link.` },
      { text: msg`Type your "Email address" and select "Send code".` },
      { text: msg`Type the code from the email in "Verification code".` },
      { text: msg`Select "Confirm code".` },
      { text: msg`Fill in the fields, select "Complete" and then "Sign".` },
      {
        text: msg`You get an email copy of the submitted document.`,
        tip: msg`"This form is closed" means it no longer takes responses. Contact the organization that shared it.`,
      },
    ],
    related: ['sign-from-a-shared-link', 'public-forms'],
    video: null,
  },
  {
    slug: 'no-account-needed',
    category: 'signers',
    audience: 'signer',
    title: msg`You do not need an account to sign`,
    summary: msg`The link in your email is all you need. It works in any up-to-date browser, on a computer or a phone.`,
    steps: [
      { text: msg`Open the email from Solid Ten Sign.` },
      { text: msg`Select the button in the email. The document opens in your browser.` },
      {
        text: msg`Sign. You do not need a password and you do not install anything.`,
        tip: msg`Keep the email. The same link opens the document again until you finish.`,
      },
      {
        text: msg`If the page asks you to sign in, contact the sender.`,
        tip: msg`Some senders send documents only to people who have an account. The sender can change this.`,
      },
    ],
    related: ['how-to-sign', 'enter-the-emailed-code'],
    video: null,
  },

  // After sending.
  {
    slug: 'track-status',
    category: 'after-sending',
    audience: 'sender',
    title: msg`See who has signed`,
    summary: msg`The document page shows each recipient's status and every step so far.`,
    steps: [
      { text: msg`On the documents page, select the document.` },
      {
        text: msg`Read the status of each person under "Recipients".`,
        tip: msg`For example "Sent", "Viewed", "Signed", "Approved", "Rejected" or "Expired".`,
      },
      { text: msg`Read "Recent activity" for each step with its time.` },
      { text: msg`Select "Load older activity" to see earlier steps.` },
      {
        text: msg`For the full record, open the three-dot menu and select "Audit Logs".`,
      },
    ],
    related: ['resend-the-request', 'the-certificate-and-audit-log', 'your-documents-page'],
    video: null,
  },
  {
    slug: 'resend-the-request',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Send a reminder now`,
    summary: msg`Send the signing email again to people who have not signed yet.`,
    steps: [
      { text: msg`Open the three-dot menu of the document.` },
      { text: msg`Select "Resend".` },
      { text: msg`Under "Send reminders to the following recipients", tick the people to remind.` },
      { text: msg`Select "Send reminder".` },
    ],
    related: ['reminders-and-expiry', 'correct-a-signers-email'],
    video: null,
  },
  {
    slug: 'correct-a-signers-email',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Fix a wrong email address after sending`,
    summary: msg`You cannot edit a recipient after sending. Reassign the request to the right address instead. The old link stops working.`,
    steps: [
      { text: msg`Open the document page.` },
      { text: msg`Under "Recipients", select the "Reassign" icon next to the person.` },
      { text: msg`Type the right "Name" and "Email".` },
      { text: msg`Type a "Reason (Optional)".` },
      {
        text: msg`Select "Reassign".`,
        tip: msg`The new address gets a fresh signing link. This works only for people who have not signed yet.`,
      },
    ],
    related: ['reassign-to-someone-else', 'document-lifecycle', 'resend-the-request'],
    video: null,
  },
  {
    slug: 'comments',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Let signers ask questions, and reply`,
    summary: msg`Turn on comments for a document. Signers ask on the signing page, and your team replies from the document page.`,
    steps: [
      { text: msg`Open the document page and find "Comments".` },
      { text: msg`Turn on "Signers can ask questions on this document".` },
      {
        text: msg`Turn on "All recipients share one thread" if everyone should see every question.`,
        tip: msg`When off, each recipient sees only their own conversation with your team.`,
      },
      { text: msg`When a question arrives, type in "Your reply" and select "Reply".` },
      { text: msg`Select "Resolve" when the question is answered.` },
    ],
    related: ['ask-a-question', 'document-lifecycle'],
    video: null,
  },
  {
    slug: 'cancel-a-document',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Cancel a document that is out for signature`,
    summary: msg`Stop the signing. The document stays in your list as a record, marked "Canceled".`,
    steps: [
      { text: msg`On the documents page, open the three-dot menu of the document.` },
      { text: msg`Select "Cancel".` },
      { text: msg`Type a "Reason (optional)".` },
      {
        text: msg`Select "Cancel document".`,
        tip: msg`The recipients get an email. Their link shows "This document was cancelled".`,
      },
    ],
    related: ['delete-a-document', 'duplicate-and-save-as-template'],
    video: null,
  },
  {
    slug: 'download-the-signed-copy',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Download the signed copy`,
    summary: msg`When everyone has signed, download the signed PDF from the document page or the list.`,
    steps: [
      { text: msg`On the documents page, choose "Completed" in "Status".` },
      { text: msg`Select "Download" in the row of the document.` },
      {
        text: msg`In "Download Files", select "Signed".`,
        tip: msg`Each party also gets the signed copy by email. A large file comes as a download link.`,
      },
    ],
    related: ['the-certificate-and-audit-log', 'resend-signed-copy'],
    video: null,
  },
  {
    slug: 'the-certificate-and-audit-log',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Get the certificate and the audit log`,
    summary: msg`The audit log records every send, view, field and signature with its time. The certificate sums up who signed, when and from which device.`,
    steps: [
      { text: msg`Open the document page.` },
      { text: msg`Open the three-dot menu and select "Audit Logs".` },
      { text: msg`Read the list of events on the page.` },
      { text: msg`Select "Download Audit Logs" to save the log as a PDF.` },
      {
        text: msg`Select "Download Certificate" to save the certificate.`,
        tip: msg`The certificate is ready when the document is completed.`,
      },
    ],
    related: ['download-the-signed-copy', 'track-status'],
    video: null,
  },
  {
    slug: 'resend-signed-copy',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Send the signed copy again when the email failed`,
    summary: msg`If the signed copy could not be emailed to someone, the document page says so and lets you send it again.`,
    steps: [
      { text: msg`Open the completed document's page.` },
      {
        text: msg`Under "Recipients", point to or tap the badge "Copy not delivered".`,
        tip: msg`A box opens under the badge. "Resend signed copy" is in that box.`,
      },
      { text: msg`Check that the email address is right.` },
      {
        text: msg`Select "Resend signed copy".`,
        tip: msg`A message says "Signed copy on its way". The badge stays until the email is sent; reload the page to check.`,
      },
      { text: msg`If it fails again, download the copy and send it another way.` },
    ],
    related: ['download-the-signed-copy', 'correct-a-signers-email'],
    video: null,
  },
  {
    slug: 'delete-a-document',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Delete or hide a document`,
    summary: msg`What happens depends on the status. A draft is deleted. A pending document is canceled and deleted. A completed one is hidden from your list.`,
    steps: [
      { text: msg`Open the three-dot menu of the document.` },
      { text: msg`Select "Delete".` },
      { text: msg`Read the list "Once confirmed, the following will occur:".` },
      { text: msg`Type the word the dialog asks for.` },
      {
        text: msg`Select "Delete".`,
        tip: msg`For a completed document, the recipients keep their copy.`,
      },
    ],
    related: ['cancel-a-document', 'retention'],
    video: null,
  },
  {
    slug: 'duplicate-and-save-as-template',
    category: 'after-sending',
    audience: 'sender',
    title: msg`Copy a document or save it as a template`,
    summary: msg`Start a new document from an old one, or keep it as a template for next time.`,
    steps: [
      { text: msg`Open the three-dot menu of the document.` },
      { text: msg`Select "Duplicate".` },
      { text: msg`Choose "Include Recipients", "Include Fields" and "Include Contents" as you need.` },
      { text: msg`Select "Duplicate". The copy is a new draft.` },
      {
        text: msg`To make a template instead, select "Save as Template" in the menu, choose what to include and select "Save as Template".`,
      },
    ],
    related: ['create-a-template', 'send-from-a-template'],
    video: null,
  },

  // Team and settings.
  {
    slug: 'profile-and-signature',
    category: 'settings',
    audience: 'sender',
    title: msg`Change your name and saved signature`,
    summary: msg`Your name shows on the requests you send. A saved signature saves time when you sign.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Account".` },
      { text: msg`Change "Full Name" if you need to.` },
      { text: msg`Draw or type your signature in "Signature".` },
      { text: msg`Select "Update profile".` },
    ],
    related: ['account-security', 'adopt-a-signature'],
    video: null,
  },
  {
    slug: 'account-security',
    category: 'settings',
    audience: 'sender',
    title: msg`Turn on two-factor authentication`,
    summary: msg`A code from an authenticator app protects your account even if someone gets into your email.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Account". Then select "Security".` },
      { text: msg`Under "Two factor authentication", select "Enable 2FA".` },
      { text: msg`Scan the QR code with your authenticator app.` },
      { text: msg`Type the code from the app in "Token" and select "Enable 2FA".` },
      {
        text: msg`Download the backup codes and keep them in a safe place.`,
        tip: msg`A change to how you sign in needs a sign-in from the last 10 minutes. It signs you out on your other devices.`,
      },
      { text: msg`To see where you are signed in, select "Manage sessions".` },
    ],
    related: ['sign-in-with-emailed-link', 'profile-and-signature'],
    video: null,
  },
  {
    slug: 'team-members',
    category: 'settings',
    audience: 'admin',
    title: msg`Add people to your organization and team`,
    summary: msg`People join your organization first, then a team. Roles decide what they can see and change.`,
    steps: [
      {
        text: msg`Ask your Solid Ten Sign administrator to create an account for the person.`,
        tip: msg`Nobody can sign up on their own. The administrator creates each account.`,
      },
      { text: msg`Open the account menu at the top right and select "Settings".` },
      { text: msg`Under "Organization Settings", select "Members" and then "Invite member".` },
      { text: msg`Type the "Email address" and choose the "Organization Role".` },
      { text: msg`Select "Invite". The person accepts the invitation from the email.` },
      {
        text: msg`Under "Team Settings", select "Members".`,
        tip: msg`If the page says "Currently all organization members can access this team", the person is already in the team. You are done.`,
      },
      { text: msg`Otherwise, select "Add members" and choose the person.` },
      { text: msg`Choose the "Team Role" and select "Add Members".` },
    ],
    related: ['document-defaults', 'usage-reports'],
    video: null,
  },
  {
    slug: 'document-defaults',
    category: 'settings',
    audience: 'admin',
    title: msg`Set the defaults for new documents`,
    summary: msg`Set the language, date format, time zone, visibility and signature types once for every new document.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Settings".` },
      { text: msg`Select "Preferences".` },
      {
        text: msg`Choose the "Default Document Visibility".`,
        tip: msg`It decides which team members can see a new document. The owner and the recipients always can.`,
      },
      {
        text: msg`Choose the "Default Document Language", "Default Date Format" and "Default Time Zone".`,
        tip: msg`The language is also used for the emails and the certificate.`,
      },
      { text: msg`Choose the "Default Signature Settings": draw, type, upload, or a mix.` },
      { text: msg`Select "Save changes".` },
      {
        text: msg`For default reminders and deadlines, open "Reminders" and set "Default Envelope Expiration" and "Default Signing Reminders".`,
      },
    ],
    related: ['email-settings', 'branding', 'reminders-and-expiry'],
    video: null,
  },
  {
    slug: 'email-settings',
    category: 'settings',
    audience: 'admin',
    title: msg`Change how our emails look to recipients`,
    summary: msg`Choose the reply-to address and whether the email names the person who sent it.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Settings".` },
      { text: msg`Under "Preferences", select "Email".` },
      { text: msg`Type a "Reply to email" and a "Reply to name".` },
      {
        text: msg`Choose "Include Sender Details".`,
        tip: msg`"Yes" shows the sender's name with the team name. "No" shows only the team name.`,
      },
      { text: msg`Select "Save changes".` },
    ],
    related: ['message-and-subject', 'branding'],
    video: null,
  },
  {
    slug: 'branding',
    category: 'settings',
    audience: 'admin',
    title: msg`Add your logo and colors`,
    summary: msg`Show your logo and colors on the signing pages and your details in the emails.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Settings".` },
      { text: msg`Under "Preferences", select "Branding".` },
      { text: msg`Set "Enable Custom Branding" to "Yes".` },
      {
        text: msg`Upload your logo in "Branding Logo".`,
        tip: msg`JPG, PNG or WebP, up to 5 MB.`,
      },
      { text: msg`Type your "Brand Website" and "Brand Details".` },
      { text: msg`Pick your colors under "Brand Colors".` },
      { text: msg`Select "Save changes".` },
    ],
    related: ['email-settings', 'document-defaults'],
    video: null,
  },
  {
    slug: 'document-lifecycle',
    category: 'settings',
    audience: 'admin',
    title: msg`Choose who may reassign, sign in person and comment`,
    summary: msg`The "Document lifecycle" page holds the switches for reassigning, in-person signing and comments.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Settings".` },
      { text: msg`Select "Document lifecycle".` },
      {
        text: msg`Set "Senders can reassign recipients" to "Allowed" or "Not allowed".`,
        tip: msg`It is allowed unless you turn it off.`,
      },
      {
        text: msg`Set "Signers can reassign to someone else".`,
        tip: msg`Off unless you turn it on, because anyone holding a forwarded link could then pass the request on.`,
      },
      { text: msg`Set "Staff can host signing in person".` },
      { text: msg`Set "Signers can ask questions" for new documents.` },
      { text: msg`Select "Save changes" in the bar at the bottom of the page.` },
    ],
    related: ['retention', 'in-person-signing', 'comments', 'correct-a-signers-email'],
    video: null,
  },
  {
    slug: 'retention',
    category: 'settings',
    audience: 'admin',
    title: msg`Delete finished documents after a set time`,
    summary: msg`A retention rule deletes finished documents a set number of days after they were completed. It is off unless you turn it on.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Settings". Then select "Document lifecycle".` },
      { text: msg`Under "Retention", set "Delete finished documents automatically" to "On".` },
      {
        text: msg`Under "What to do", choose "Delete (hide from lists, keep the files)" or "Delete permanently (remove the files)".`,
        tip: msg`Permanently deleted documents cannot be recovered.`,
      },
      {
        text: msg`Type the "Days after the document finished".`,
        tip: msg`The page shows how many documents the rule affects.`,
      },
      { text: msg`Tick "Also rejected documents" or "Also cancelled documents" if you want.` },
      {
        text: msg`Select "Save changes".`,
        tip: msg`Drafts, documents that wait for signatures and templates are never touched. On our server, automatic deletion runs in a test mode for now: it records what it would delete and deletes nothing.`,
      },
    ],
    related: ['document-lifecycle', 'delete-a-document'],
    video: null,
  },
  {
    slug: 'webhooks',
    category: 'settings',
    audience: 'admin',
    title: msg`Tell another system when something happens (webhooks)`,
    summary: msg`A webhook calls your web address when a document is sent, signed, completed, rejected or canceled.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Settings".` },
      { text: msg`Under "Team Settings", select "Webhooks".` },
      { text: msg`Select "Create Webhook".` },
      { text: msg`Type the "Webhook URL".` },
      { text: msg`Choose the events under "Triggers".` },
      {
        text: msg`Type a "Secret".`,
        tip: msg`Each call is signed with the secret in the header X-SolidTen-Signature, so your system can check that it came from us.`,
      },
      { text: msg`Select "Create".` },
      { text: msg`To see what was sent, open the webhook's menu and select "Logs".` },
    ],
    related: ['api-tokens', 'connect-other-tools'],
    video: null,
  },
  {
    slug: 'api-tokens',
    category: 'settings',
    audience: 'admin',
    title: msg`Make an API token`,
    summary: msg`An API token lets your own software create, send and read documents for your team.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Settings".` },
      { text: msg`Under "Team Settings", select "API Tokens".` },
      { text: msg`Select "Create token".` },
      { text: msg`Type a "Name" that tells you what the token is for.` },
      { text: msg`Choose when it ends in "Expires in".` },
      { text: msg`Select "Create token".` },
      {
        text: msg`Copy "Your new API token" and keep it in a safe place.`,
        tip: msg`You will not see the token again. Anyone who has it can act for your team.`,
      },
    ],
    related: ['webhooks', 'connect-other-tools'],
    video: null,
  },
  {
    slug: 'usage-reports',
    category: 'settings',
    audience: 'admin',
    title: msg`See how many documents your team sends`,
    summary: msg`The analytics page counts documents sent, completed and declined, and how long they took.`,
    steps: [
      { text: msg`Open the account menu at the top right and select "Analytics".` },
      {
        text: msg`Choose a "Date range".`,
        tip: msg`A document counts for its owner.`,
      },
      { text: msg`Read "Documents sent", "Completion rate" and "Status breakdown".` },
      { text: msg`Under "Usage report", select "Members CSV" or "Documents CSV" to save a list.` },
    ],
    related: ['team-members', 'track-status'],
    video: null,
  },
  {
    slug: 'connect-other-tools',
    category: 'settings',
    audience: 'admin',
    title: msg`Connect Solid Ten Sign to your other tools`,
    summary: msg`Webhooks tell other tools what happened. API tokens let other tools create and send documents. Together they connect automation tools to Solid Ten Sign.`,
    steps: [
      { text: msg`Decide what should happen, for example "when a document is completed, save it to our files".` },
      { text: msg`For events going out, create a webhook with a secret.` },
      { text: msg`For actions coming in, make an API token.` },
      {
        text: msg`Set up the other tool with the webhook address or the token.`,
        tip: msg`The same event can arrive more than once. Make your tool ignore repeats.`,
      },
      { text: msg`Need help with the setup? Email support@solidten.io.` },
    ],
    related: ['webhooks', 'api-tokens'],
    video: null,
  },
];

export const findHelpTopic = (slug: string) => HELP_TOPICS.find((topic) => topic.slug === slug);

export const HELP_TOPIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
