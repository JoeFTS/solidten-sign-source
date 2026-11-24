import { createHash, randomBytes } from 'node:crypto';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';
import { prisma } from '@documenso/prisma';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, RecipientRole } from '@prisma/client';

import { apiCreateTestContext, apiSeedPendingDocument } from '../fixtures/api-seeds';
import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign, task R.
 * R-1: a recipient who completed their part cannot be removed, and keeps email and role, on every
 * route. R-2: API v1 recipient delete on a sent document answers properly. R-3: a role change
 * between linked roles keeps the recipient's send status.
 */

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const V2 = `${BASE}/api/v2-beta`;

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const messageOf = async (response: APIResponse) => {
  const text = await response.text();

  try {
    const body = JSON.parse(text) as { message?: string; error?: { json?: { message?: string } } };

    return body.error?.json?.message ?? body.message ?? text;
  } catch {
    return text;
  }
};

const trpc = async (
  request: APIRequestContext,
  path: string,
  json: unknown,
  extraHeaders: Record<string, string> = {},
) =>
  await request.post(`${BASE}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', ...extraHeaders },
    data: JSON.stringify({ json }),
  });

const signInByEmailLink = async (page: Page, userId: number) => {
  const token = randomBytes(32).toString('hex');

  await prisma.verificationToken.create({
    data: {
      identifier: 'email-link-signin',
      token: createHash('sha256').update(token).digest('hex'),
      expires: new Date(Date.now() + 15 * 60 * 1000),
      userId,
    },
  });

  const response = await page.context().request.post(`${BASE}/api/auth/email-link/authorize`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ token }),
  });

  expect(response.ok(), await response.text()).toBe(true);
};

/** A sent document: Ann has signed, Ben has opened it, Cat has filled one of her fields. */
const seedSentDocument = async (request: APIRequestContext) => {
  const context = await apiCreateTestContext('r');
  const stamp = Date.now();
  const emails = [`ann-${stamp}@example.com`, `ben-${stamp}@example.com`, `cat-${stamp}@example.com`];
  const signature = (y: number) => ({
    type: FieldType.SIGNATURE,
    page: 1,
    positionX: 60,
    positionY: y,
    width: 20,
    height: 5,
  });
  const text = (y: number) => ({ type: FieldType.TEXT, page: 1, positionX: 10, positionY: y, width: 20, height: 5 });

  const { envelope } = await apiSeedPendingDocument(request, {
    context,
    recipients: [
      { email: emails[0], name: 'Ann Lee' },
      { email: emails[1], name: 'Ben Ortiz' },
      { email: emails[2], name: 'Cat Diaz' },
    ],
    fieldsPerRecipient: [
      [signature(5), text(10)],
      [signature(20), text(25)],
      [signature(35), text(40)],
    ],
  });

  const row = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });
  const documentId = Number(row.secondaryId.replace('document_', ''));
  const byEmail = async (email: string) =>
    await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id, email } });
  const [ann, ben, cat] = await Promise.all(emails.map(byEmail));

  // Ann signs and completes.
  for (const field of await prisma.field.findMany({ where: { recipientId: ann.id } })) {
    const value = field.type === FieldType.SIGNATURE ? 'Ann Lee' : 'Hello';
    const signed = await trpc(request, 'envelope.field.sign', {
      token: ann.token,
      fieldId: field.id,
      fieldValue: { type: field.type, value },
    });
    expect(signed.ok(), await signed.text()).toBe(true);
  }
  const completed = await trpc(request, 'recipient.completeDocumentWithToken', { token: ann.token, documentId });
  expect(completed.ok(), await completed.text()).toBe(true);

  // Ben opened it; Cat filled her text field.
  await prisma.recipient.update({ where: { id: ben.id }, data: { readStatus: 'OPENED' } });
  const catText = await prisma.field.findFirstOrThrow({ where: { recipientId: cat.id, type: FieldType.TEXT } });
  const filled = await trpc(request, 'envelope.field.sign', {
    token: cat.token,
    fieldId: catText.id,
    fieldValue: { type: FieldType.TEXT, value: 'Partly' },
  });
  expect(filled.ok(), await filled.text()).toBe(true);

  return { context, envelopeId: envelope.id, documentId, ann: await byEmail(emails[0]), ben, cat, emails };
};

const snapshot = async (recipientId: number) => {
  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });
  const fields = await prisma.field.findMany({ where: { recipientId }, orderBy: { id: 'asc' } });
  const signatures = await prisma.signature.findMany({ where: { recipientId }, orderBy: { id: 'asc' } });

  return JSON.stringify({ recipient, fields, signatures });
};

const ANN_REMOVE = /^Ann Lee \(ann-\d+@example\.com\) has already signed and cannot be removed\.$/;
const ANN_CHANGE = /^Ann Lee \(ann-\d+@example\.com\) has already signed, so their email and role cannot be changed\.$/;

test('R-1: a signed recipient cannot be removed or have email/role changed, on every route', async ({
  page,
  request,
}) => {
  const { context, envelopeId, documentId, ann, ben, cat } = await seedSentDocument(request);
  const before = await snapshot(ann.id);
  const auth = { Authorization: `Bearer ${context.token}` };
  const others = [ben, cat].map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role }));
  const results: Record<string, { status: number; message: string }> = {};

  const record = async (name: string, response: APIResponse) => {
    results[name] = { status: response.status(), message: await messageOf(response) };
  };

  await signInByEmailLink(page, context.user.id);
  const web = page.context().request;
  const team = { 'x-team-id': String(context.team.id) };

  // Remove Ann.
  await record(
    'web recipient.setDocumentRecipients (remove)',
    await trpc(web, 'recipient.setDocumentRecipients', { documentId, recipients: others }, team),
  );
  await record(
    'web envelope.recipient.set (remove)',
    await trpc(web, 'envelope.recipient.set', { envelopeId, envelopeType: 'DOCUMENT', recipients: others }, team),
  );
  await record(
    'v2 recipient/delete',
    await request.post(`${V2}/envelope/recipient/delete`, { headers: auth, data: { recipientId: ann.id } }),
  );
  await record(
    'v1 DELETE recipient',
    await request.delete(`${BASE}/api/v1/documents/${documentId}/recipients/${ann.id}`, { headers: auth, data: {} }),
  );

  const { token: presign } = await createEmbeddingPresignToken({
    apiToken: context.token,
    scope: `documentId:${documentId}`,
  });
  await record(
    'embedding updateEmbeddingDocument (remove)',
    await trpc(
      request,
      'embeddingPresign.updateEmbeddingDocument',
      { documentId, title: 'R', recipients: others },
      { Authorization: `Bearer ${presign}` },
    ),
  );

  // Change Ann's email or role.
  const annAs = (change: Partial<{ email: string; role: RecipientRole }>) => ({
    id: ann.id,
    email: change.email ?? ann.email,
    name: ann.name,
    role: change.role ?? ann.role,
  });

  await record(
    'web envelope.recipient.set (email)',
    await trpc(
      web,
      'envelope.recipient.set',
      { envelopeId, envelopeType: 'DOCUMENT', recipients: [annAs({ email: 'new-ann@example.com' }), ...others] },
      team,
    ),
  );
  await record(
    'v2 recipient/update-many (role)',
    await request.post(`${V2}/envelope/recipient/update-many`, {
      headers: auth,
      data: { envelopeId, data: [annAs({ role: RecipientRole.APPROVER })] },
    }),
  );
  await record(
    'v1 PATCH recipient (email)',
    await request.patch(`${BASE}/api/v1/documents/${documentId}/recipients/${ann.id}`, {
      headers: auth,
      data: { name: ann.name, email: 'new-ann@example.com' },
    }),
  );

  for (const [name, result] of Object.entries(results)) {
    expect(result.status, name).toBe(400);
    expect(result.message, name).toMatch(
      name.includes('(email)') || name.includes('(role)') || name.includes('PATCH') ? ANN_CHANGE : ANN_REMOVE,
    );
  }

  expect(await snapshot(ann.id)).toBe(before);
  console.log(`R-1 answers: ${JSON.stringify(results, null, 1)}`);
});

test('R-1: what happens to a recipient who viewed or partly filled, but did not complete', async ({
  page,
  request,
}) => {
  const { context, envelopeId, documentId, ann, ben, cat } = await seedSentDocument(request);
  const auth = { Authorization: `Bearer ${context.token}` };

  // API v2 delete: a recipient with a filled field has "interacted" and is refused (as before).
  const v2Cat = await request.post(`${V2}/envelope/recipient/delete`, { headers: auth, data: { recipientId: cat.id } });
  console.log(`R-1 v2 delete of the partly filled recipient: ${v2Cat.status()} ${await messageOf(v2Cat)}`);
  expect(v2Cat.status()).toBe(400);

  // The editor's save removes her, with her fields (the filled value too): allowed, as before.
  await signInByEmailLink(page, context.user.id);
  const keep = [ann, ben].map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role }));
  const set = await trpc(
    page.context().request,
    'envelope.recipient.set',
    { envelopeId, envelopeType: 'DOCUMENT', recipients: keep },
    { 'x-team-id': String(context.team.id) },
  );
  console.log(
    `R-1 editor save without the partly filled recipient: ${set.status()} ${(await messageOf(set)).slice(0, 160)}`,
  );
  expect(await prisma.recipient.count({ where: { id: cat.id } })).toBe(set.ok() ? 0 : 1);
  expect(await prisma.field.count({ where: { recipientId: cat.id } })).toBe(set.ok() ? 0 : 2);

  // R-2: API v1 delete of the viewed (unsigned, nothing filled) recipient on the sent document.
  const v1Ben = await request.delete(`${BASE}/api/v1/documents/${documentId}/recipients/${ben.id}`, {
    headers: auth,
    data: {},
  });
  console.log(`R-2 v1 delete of the viewed recipient: ${v1Ben.status()} ${(await messageOf(v1Ben)).slice(0, 160)}`);
  expect(v1Ben.status()).not.toBe(500);
  expect(v1Ben.ok()).toBe(true);
  expect(await prisma.recipient.count({ where: { id: ben.id } })).toBe(0);
});

test('R-3: a role change between linked roles keeps SENT; to CC resets', async ({ request }) => {
  const { context, envelopeId, ben } = await seedSentDocument(request);
  const auth = { Authorization: `Bearer ${context.token}` };

  const setRole = async (role: RecipientRole) =>
    await request.post(`${V2}/envelope/recipient/update-many`, {
      headers: auth,
      data: { envelopeId, data: [{ id: ben.id, email: ben.email, name: ben.name, role }] },
    });

  expect((await setRole(RecipientRole.APPROVER)).ok()).toBe(true);
  let row = await prisma.recipient.findUniqueOrThrow({ where: { id: ben.id } });
  expect([row.role, row.sendStatus, row.token]).toEqual([RecipientRole.APPROVER, 'SENT', ben.token]);

  expect((await setRole(RecipientRole.VIEWER)).ok()).toBe(true);
  row = await prisma.recipient.findUniqueOrThrow({ where: { id: ben.id } });
  expect([row.role, row.sendStatus]).toEqual([RecipientRole.VIEWER, 'SENT']);

  // The old link still opens for the new role.
  const open = await request.get(`${BASE}/sign/${ben.token}`);
  expect(open.status()).toBe(200);
});

test('R-2a: an API v1 request with a JSON content type and an empty or broken body: a plain 400', async ({
  request,
}) => {
  const { context, documentId, ann, cat } = await seedSentDocument(request);
  const headers = { Authorization: `Bearer ${context.token}`, 'content-type': 'application/json' };

  for (const [recipient, body] of [
    [ann, undefined],
    [cat, Buffer.from('{not json')],
  ] as const) {
    const response = await request.fetch(`${BASE}/api/v1/documents/${documentId}/recipients/${recipient.id}`, {
      method: 'DELETE',
      headers,
      ...(body ? { data: body } : {}),
    });

    expect(response.status()).toBe(400);
    expect(await messageOf(response)).toMatch(/^The request body is not valid JSON\./);
    expect(await prisma.recipient.count({ where: { id: recipient.id } })).toBe(1);
  }

  // A proper request (no content type) gets the route's own answer: the R-1 refusal.
  const proper = await request.fetch(`${BASE}/api/v1/documents/${documentId}/recipients/${ann.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${context.token}` },
  });
  expect(proper.status()).toBe(400);
  expect(await messageOf(proper)).toMatch(ANN_REMOVE);
});

test('R-2b: API v1 POST field with a recipient of another envelope is a 404; nothing is created', async ({
  request,
}) => {
  const first = await seedSentDocument(request);
  const other = await seedSentDocument(request);

  // A draft of the first team, so fields may be added.
  await prisma.envelope.update({ where: { id: first.envelopeId }, data: { status: 'DRAFT' } });
  const before = await prisma.field.count({ where: { envelopeId: first.envelopeId } });

  const response = await request.post(`${BASE}/api/v1/documents/${first.documentId}/fields`, {
    headers: { Authorization: `Bearer ${first.context.token}` },
    data: {
      recipientId: other.ben.id,
      type: 'SIGNATURE',
      pageNumber: 1,
      pageX: 10,
      pageY: 10,
      pageWidth: 10,
      pageHeight: 5,
      fieldMeta: { type: 'signature' },
    },
  });

  expect(response.status()).toBe(404);
  expect(await messageOf(response)).toBe('Recipient not found');
  expect(await prisma.field.count({ where: { envelopeId: first.envelopeId } })).toBe(before);
});

test('R-1: with one signer signed, the editor can still reorder, rename and add the others', async ({
  page,
  request,
}) => {
  const { context, envelopeId, ann, ben, cat } = await seedSentDocument(request);
  const before = await snapshot(ann.id);

  // Cat filled a field in the shared fixture. A partly filled recipient cannot be modified at all
  // (upstream rule "Cannot modify a recipient who has already interacted", reorder included), so
  // here the others have filled nothing: only Ann has acted.
  await prisma.field.updateMany({ where: { recipientId: cat.id }, data: { inserted: false, customText: '' } });

  await signInByEmailLink(page, context.user.id);
  const save = async (recipients: unknown[]) =>
    await trpc(
      page.context().request,
      'envelope.recipient.set',
      { envelopeId, envelopeType: 'DOCUMENT', recipients },
      { 'x-team-id': String(context.team.id) },
    );

  const as = (r: typeof ann, extra: Record<string, unknown> = {}) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    ...extra,
  });

  // Re-save unchanged, reorder Ben and Cat, rename Ben, add Dan: all in one editor save.
  const unchanged = await save([as(ann), as(ben), as(cat)]);
  expect(unchanged.ok(), await unchanged.text()).toBe(true);

  const edited = await save([
    as(ann, { signingOrder: 1 }),
    as(cat, { signingOrder: 2 }),
    as(ben, { signingOrder: 3, name: 'Benjamin Ortiz' }),
    { email: `dan-${Date.now()}@example.com`, name: 'Dan Kim', role: RecipientRole.SIGNER, signingOrder: 4 },
  ]);
  expect(edited.ok(), await edited.text()).toBe(true);

  const rows = await prisma.recipient.findMany({ where: { envelopeId }, orderBy: { id: 'asc' } });
  expect(rows.map((r) => r.name)).toEqual(['Ann Lee', 'Benjamin Ortiz', 'Cat Diaz', 'Dan Kim']);
  expect(rows.find((r) => r.id === cat.id)?.signingOrder).toBe(2);
  expect(rows.find((r) => r.id === ben.id)?.signingOrder).toBe(3);
  // Ben keeps SENT and his token (R-3 / Q-4).
  expect([rows.find((r) => r.id === ben.id)?.sendStatus, rows.find((r) => r.id === ben.id)?.token]).toEqual([
    'SENT',
    ben.token,
  ]);

  // Ann is untouched, apart from what the save itself is allowed to set (her signing order is unchanged).
  expect(JSON.parse(await snapshot(ann.id)).fields).toEqual(JSON.parse(before).fields);
  expect(JSON.parse(await snapshot(ann.id)).signatures).toEqual(JSON.parse(before).signatures);
  const annNow = rows.find((r) => r.id === ann.id)!;
  expect([annNow.email, annNow.role, annNow.signingStatus, annNow.token]).toEqual([
    ann.email,
    ann.role,
    'SIGNED',
    ann.token,
  ]);
});
