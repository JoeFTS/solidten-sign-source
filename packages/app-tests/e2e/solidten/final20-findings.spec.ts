import { jobs } from '@documenso/lib/jobs/client';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, SigningStatus } from '@documenso/prisma/client';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSeedDraftDocument } from '../fixtures/api-seeds';
import { apiSignin } from '../fixtures/authentication';
import {
  clickAddMyselfButton,
  clickEnvelopeEditorStep,
  getRecipientEmailInputs,
  openDocumentEnvelopeEditor,
} from '../fixtures/envelope-editor';

/**
 * Solid Ten Sign, findings from final20 (task I).
 * F-1: "organisation email off" applies to the "recipient signed" and "created from direct
 * template" mails. F-2: a refused send shows the server's reason in the send dialog.
 */

test.describe.configure({ mode: 'parallel' });

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const uniqueEmail = (label: string) =>
  `final20-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 60_000) => {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    if (await check()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
};

const mailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

/** A pending document with one signer who has signed; its organisation's email on or off. */
const seedSignedRecipient = async ({ isEmailOff }: { isEmailOff: boolean }) => {
  const { user, team } = await seedUser();
  const title = `[TEST] Final20 ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const document = await seedPendingDocument(user, team.id, [uniqueEmail('signer'), uniqueEmail('other')], {
    internalVersion: 2,
    createDocumentOptions: { title },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
  await prisma.recipient.update({
    where: { id: recipient.id },
    data: { signingStatus: SigningStatus.SIGNED, signedAt: new Date() },
  });

  if (isEmailOff) {
    const { organisation } = await prisma.team.findUniqueOrThrow({
      where: { id: team.id },
      select: { organisation: { select: { organisationClaim: true } } },
    });
    const claim = organisation.organisationClaim;

    await prisma.organisationClaim.update({
      where: { id: claim.id },
      data: { flags: { ...(claim.flags as Record<string, unknown>), disableEmails: true } },
    });
  }

  return { user, title, document, recipient };
};

const jobDone = async (jobId: string, key: string, value: string | number) =>
  await waitFor(async () => {
    const job = await prisma.backgroundJob.findFirst({
      where: { jobId, payload: { path: [key], equals: value } },
      orderBy: { submittedAt: 'desc' },
    });

    return job?.status === 'COMPLETED';
  });

test.describe('F-1: organisation email off', () => {
  test.skip(!MAIL_SINK_URL, 'needs E2E_MAIL_SINK_URL');

  for (const isEmailOff of [false, true]) {
    test(`"recipient signed" mail with email ${isEmailOff ? 'off: not sent' : 'on: sent (control)'}`, async () => {
      const { user, title, document, recipient } = await seedSignedRecipient({ isEmailOff });
      const documentId = mapSecondaryIdToDocumentId(document.secondaryId);

      await jobs.triggerJob({
        name: 'send.recipient.signed.email',
        payload: { documentId, recipientId: recipient.id },
      });

      expect(await jobDone('send.recipient.signed.email', 'documentId', documentId)).toBe(true);

      const matching = async () => (await mailSubjects(user.email)).filter((subject) => subject.includes(title));

      if (isEmailOff) {
        // Give a sent mail time to arrive before concluding there is none.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(await matching()).toEqual([]);
      } else {
        expect(await waitFor(async () => (await matching()).length === 1)).toBe(true);
      }
    });

    test(`"created from direct template" mail with email ${isEmailOff ? 'off: not sent' : 'on: sent (control)'}`, async () => {
      const { user, document, recipient } = await seedSignedRecipient({ isEmailOff });
      const before = (await mailSubjects(user.email)).length;

      await jobs.triggerJob({
        name: 'send.document.created.from.direct.template.email',
        payload: { envelopeId: document.id, recipientId: recipient.id },
      });

      expect(await jobDone('send.document.created.from.direct.template.email', 'envelopeId', document.id)).toBe(true);

      if (isEmailOff) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(await mailSubjects(user.email)).toHaveLength(before);
      } else {
        expect(
          await waitFor(async () =>
            (await mailSubjects(user.email)).some((subject) => subject === 'Document created from direct template'),
          ),
        ).toBe(true);
      }
    });
  }
});

test('F-2: a refused send shows the server reason in the dialog, which stays open', async ({ page, request }) => {
  const { envelope, user, team } = await apiSeedDraftDocument(request, {
    recipients: [{ email: uniqueEmail('f2'), name: 'F2 Signer' }],
    fieldsPerRecipient: [
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 },
        {
          type: FieldType.NUMBER,
          page: 1,
          positionX: 5,
          positionY: 25,
          width: 25,
          height: 5,
          fieldMeta: { type: 'number', label: 'Total', formula: '{{price}} * {{qty}}' },
        },
      ],
    ],
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}/edit` });

  await page.locator('button[title="Send Envelope"]').click();
  await expect(page.getByRole('heading', { name: 'Send Document' })).toBeVisible();

  await page.getByRole('tab', { name: 'None' }).click();
  await page.getByRole('button', { name: 'Generate Links' }).click();

  const reason = page.getByTestId('envelope-distribute-error');
  await expect(reason).toBeVisible();
  await expect(reason).toContainText('The document was not sent');
  await expect(reason).toContainText('uses the field key "price", but no field has that key');

  // The dialog stays open and the document stays a draft.
  await expect(page.getByRole('heading', { name: 'Send Document' })).toBeVisible();
  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).status).toBe(DocumentStatus.DRAFT);
});

/* -------------------------------------------------------------------------- */
/*   F-5: typing a character limit never cuts the sender's text               */
/* -------------------------------------------------------------------------- */

test('F-5: typing "120" key by key keeps the prefilled text; a short limit is an error, not a cut', async ({
  page,
}) => {
  const surface = await openDocumentEnvelopeEditor(page);
  const root = surface.root;
  const prefilled = 'Nut-free tray, please.';

  await clickAddMyselfButton(root);
  await expect(getRecipientEmailInputs(root).first()).toHaveValue(surface.userEmail);

  await clickEnvelopeEditorStep(root, 'addFields');
  const canvas = root.locator('.konva-container canvas').first();
  await expect(canvas).toBeVisible();

  await root.getByRole('button', { name: 'Text', exact: true }).click();
  await canvas.click({ position: { x: 120, y: 120 } });

  const text = root.locator('[data-testid="field-form-text"]');
  const limit = root.locator('[data-testid="field-form-characterLimit"]');

  await text.fill(prefilled);

  // Key by key, as a person types: "1", then "12", then "120".
  await limit.click();
  await limit.pressSequentially('120', { delay: 80 });

  await expect(limit).toHaveValue('120');
  await expect(text).toHaveValue(prefilled);

  // A limit shorter than the text: an error, the text stays.
  await limit.fill('5');
  await expect(text).toHaveValue(prefilled);
  await expect(root.getByText('The text is longer than the character limit.')).toBeVisible();

  // Back to a limit that fits: saved with the whole text.
  await limit.fill('120');
  await expect(root.getByText('The text is longer than the character limit.')).toHaveCount(0);
  await page.waitForTimeout(500);
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');

  await expect
    .poll(async () => {
      const field = await prisma.field.findFirst({
        where: { envelopeId: surface.envelopeId, type: FieldType.TEXT },
      });

      return field?.fieldMeta;
    })
    .toMatchObject({ text: prefilled, characterLimit: 120 });
});

/* -------------------------------------------------------------------------- */
/*   F-6: no "Sign up" when sign-up is off                                    */
/* -------------------------------------------------------------------------- */

test.describe('F-6: sign-up turned off (NEXT_PUBLIC_DISABLE_SIGNUP=true on the app and the tests)', () => {
  test.skip(process.env.NEXT_PUBLIC_DISABLE_SIGNUP !== 'true', 'needs NEXT_PUBLIC_DISABLE_SIGNUP=true');

  test('an account-required document offers "Login", never "Sign up", to a signer without an account', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const document = await seedPendingDocument(user, team.id, [uniqueEmail('no-account')], {
      createDocumentOptions: {
        authOptions: createDocumentAuthOptions({ globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] }),
      },
    });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

    await page.goto(`/sign/${recipient.token}`);

    await expect(page.getByRole('heading', { name: 'Authentication required' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign up' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    await expect(page.getByTestId('signing-auth-no-signup')).toBeVisible();
  });

  test('the sign-in and reset-password pages show no sign-up link', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(0);

    // A reset-password link with an unknown token still renders the page frame.
    await page.goto('/reset-password/not-a-real-token');
    await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(0);
  });
});
