/**
 * SEC3-C1 (security retest, critical): a recipient whose access needs a signed-in account could
 * be signed, completed and declined with the link alone, signed out. Every route that acts on a
 * signing link token now applies the recipient's access requirement, the same rule as the
 * signing page.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

const ACCOUNT_REQUIRED = 'Sign in with the account this document was sent to';

const trpcPost = async (request: APIRequestContext, path: string, json: unknown) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json }),
  });

const trpcGet = async (request: APIRequestContext, path: string, json: unknown) =>
  await request.get(`${WEBAPP_BASE_URL}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json }))}`, {
    headers: WEBAPP_ORIGIN_HEADERS,
  });

const expectAccountRequired = async (response: APIResponse) => {
  const body = await response.text();

  expect(response.status(), body).toBe(401);
  expect(body).toContain(ACCOUNT_REQUIRED);
  expect(body).not.toMatch(/prisma\.|Invalid `/);
};

type TAccess = 'ACCOUNT' | 'TWO_FACTOR_AUTH' | null;

/** A pending document for one signer who has an account, with the given access requirement. */
const seedDocument = async (request: APIRequestContext, access: TAccess) => {
  const { user: signerUser } = await seedUser();

  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] Account access',
    recipients: [{ email: signerUser.email, name: 'Account Signer', role: 'SIGNER' }],
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: seeded.envelope.id } });

  if (access) {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { authOptions: { accessAuth: [access], actionAuth: [] } },
    });
  }

  const field = await prisma.field.findFirstOrThrow({ where: { recipientId: recipient.id, type: 'SIGNATURE' } });
  const documentId = Number(seeded.envelope.secondaryId.replace(/\D/g, ''));

  return { ...seeded, signerUser, recipient, field, documentId };
};

/** Nothing the signed-out calls could have changed has changed. */
const expectUntouched = async (envelopeId: string, recipientId: number, fieldId: number) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });
  expect(field.inserted).toBe(false);
  expect(field.customText).toBe('');
  expect(await prisma.signature.count({ where: { fieldId } })).toBe(0);

  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });
  expect(recipient.signingStatus).toBe('NOT_SIGNED');

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  expect(envelope.status).toBe('PENDING');

  const types = (await prisma.documentAuditLog.findMany({ where: { envelopeId } })).map((log) => log.type);
  for (const type of [
    'DOCUMENT_FIELD_INSERTED',
    'DOCUMENT_FIELD_UNINSERTED',
    'DOCUMENT_RECIPIENT_COMPLETED',
    'DOCUMENT_RECIPIENT_REJECTED',
    'DOCUMENT_COMPLETED',
    'DOCUMENT_OPENED',
    'DOCUMENT_VIEWED',
  ]) {
    expect(types).not.toContain(type);
  }
};

/** Every token route an ACCOUNT recipient's link reaches, called with the link alone. */
const callEveryTokenRoute = async (
  request: APIRequestContext,
  { token, fieldId, documentId }: { token: string; fieldId: number; documentId: number },
) => {
  const form = new FormData();
  form.append('payload', JSON.stringify({ token, fieldId }));
  form.append('file', new File([Buffer.from('%PDF-1.4 test')], 'proof.pdf', { type: 'application/pdf' }));

  return {
    'envelope.field.sign': await trpcPost(request, 'envelope.field.sign', {
      token,
      fieldId,
      fieldValue: { type: 'SIGNATURE', value: 'Forger' },
    }),
    'field.signFieldWithToken': await trpcPost(request, 'field.signFieldWithToken', {
      token,
      fieldId,
      value: 'Forger',
    }),
    'field.removeSignedFieldWithToken': await trpcPost(request, 'field.removeSignedFieldWithToken', { token, fieldId }),
    'recipient.completeDocumentWithToken': await trpcPost(request, 'recipient.completeDocumentWithToken', {
      token,
      documentId,
    }),
    'recipient.rejectDocumentWithToken': await trpcPost(request, 'recipient.rejectDocumentWithToken', {
      token,
      documentId,
      reason: 'Forged decline',
    }),
    'fieldFile.upload': await request.post(`${WEBAPP_BASE_URL}/api/trpc/fieldFile.upload`, {
      headers: WEBAPP_ORIGIN_HEADERS,
      multipart: form,
    }),
    'fieldFile.remove': await trpcPost(request, 'fieldFile.remove', { token, fieldId, fileId: 'none' }),
    'fieldFile.listForSigner': await trpcGet(request, 'fieldFile.listForSigner', { token }),
    'envelope.item.getManyByToken': await trpcGet(request, 'envelope.item.getManyByToken', {
      envelopeId: 'unused',
      access: { type: 'recipient', token },
    }),
    'envelope.attachment.find': await trpcGet(request, 'envelope.attachment.find', { envelopeId: 'unused', token }),
    'embeddingPresign.getMultiSignDocument': await trpcGet(request, 'embeddingPresign.getMultiSignDocument', {
      token,
    }),
    'embeddingPresign.persistEmbedSignature': await trpcPost(request, 'embeddingPresign.persistEmbedSignature', {
      token,
      signature: 'Forger',
    }),
    'comment.postAsRecipient': await trpcPost(request, 'comment.postAsRecipient', { token, body: 'Hello' }),
    'lifecycle.reassignRecipientWithToken': await trpcPost(request, 'lifecycle.reassignRecipientWithToken', {
      token,
      name: 'Someone Else',
      email: `else-${Date.now()}@test.documenso.com`,
    }),
  };
};

test('[SEC3-C1]: signed out, an ACCOUNT recipient link signs, completes, declines and uploads nothing', async ({
  request,
}) => {
  const { envelope, recipient, field, documentId } = await seedDocument(request, 'ACCOUNT');

  const responses = await callEveryTokenRoute(request, { token: recipient.token, fieldId: field.id, documentId });

  for (const [path, response] of Object.entries(responses)) {
    await test.step(path, async () => {
      // Comments and reassignment refused before this fix, with their own wording.
      if (path === 'comment.postAsRecipient' || path === 'lifecycle.reassignRecipientWithToken') {
        expect(response.ok(), path).toBe(false);
        expect(response.status(), path).toBeLessThan(500);

        return;
      }

      await expectAccountRequired(response);
    });
  }

  // The field file download route answers 404 for anything a token may not see.
  const download = await request.get(`${WEBAPP_BASE_URL}/api/files/token/${recipient.token}/field-file/none`);
  expect(download.status()).toBe(404);

  await expectUntouched(envelope.id, recipient.id, field.id);
});

const signInAs = async (page: Page, email: string) => {
  await apiSignin({ page, email });

  return page.context().request;
};

test('[SEC3-C1]: signed in as another account, the link is refused; as the recipient it works', async ({
  page,
  request,
}) => {
  const { envelope, recipient, field, documentId, signerUser } = await seedDocument(request, 'ACCOUNT');

  // Another account: refused, nothing changes.
  const { user: other } = await seedUser();
  const asOther = await signInAs(page, other.email);

  await expectAccountRequired(
    await trpcPost(asOther, 'envelope.field.sign', {
      token: recipient.token,
      fieldId: field.id,
      fieldValue: { type: 'SIGNATURE', value: 'Not me' },
    }),
  );
  await expectAccountRequired(
    await trpcPost(asOther, 'recipient.completeDocumentWithToken', { token: recipient.token, documentId }),
  );
  await expectUntouched(envelope.id, recipient.id, field.id);

  // The recipient's own account: signs and completes.
  await page.context().clearCookies();
  const asSigner = await signInAs(page, signerUser.email);

  const sign = await trpcPost(asSigner, 'envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Account Signer' },
  });
  expect(sign.ok(), await sign.text()).toBe(true);

  const complete = await trpcPost(asSigner, 'recipient.completeDocumentWithToken', {
    token: recipient.token,
    documentId,
  });
  expect(complete.ok(), await complete.text()).toBe(true);

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus).toBe('SIGNED');
});

test('[SEC3-C1]: a recipient with no access requirement still signs with the link alone', async ({ request }) => {
  const { recipient, field, documentId } = await seedDocument(request, null);

  const sign = await trpcPost(request, 'envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Link Signer' },
  });
  expect(sign.ok(), await sign.text()).toBe(true);

  const complete = await trpcPost(request, 'recipient.completeDocumentWithToken', {
    token: recipient.token,
    documentId,
  });
  expect(complete.ok(), await complete.text()).toBe(true);

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus).toBe('SIGNED');
});

test('[SEC3-C1]: a two-factor (email code) recipient behaves as before: fields sign, completion needs the code', async ({
  request,
}) => {
  const { recipient, field, documentId } = await seedDocument(request, 'TWO_FACTOR_AUTH');

  const sign = await trpcPost(request, 'envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Code Signer' },
  });
  expect(sign.ok(), await sign.text()).toBe(true);

  // Without the code the completion is refused by the two-factor check, not the account check.
  const complete = await trpcPost(request, 'recipient.completeDocumentWithToken', {
    token: recipient.token,
    documentId,
  });
  const body = await complete.text();
  expect(complete.ok()).toBe(false);
  expect(body).not.toContain(ACCOUNT_REQUIRED);

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus).toBe('NOT_SIGNED');
});
