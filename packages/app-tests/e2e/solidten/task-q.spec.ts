import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, RecipientRole } from '@prisma/client';
import pg from 'pg';

import {
  apiCreateTestContext,
  apiSeedDraftDocument,
  apiSeedPendingDocument,
  apiSeedTemplate,
} from '../fixtures/api-seeds';

/**
 * Solid Ten Sign, task Q.
 * Q-1: a direct link can only be turned on when a visitor can use it (signer exists, is a SIGNER,
 * has an unconditional signature field), race-proof with the same advisory lock. Links that are
 * already on and broken stay editable; deleting is never blocked.
 * (Q-2, deadlocks answered as "try again", is a unit test: database-errors.test.ts.)
 */

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const V2 = `${BASE}/api/v2-beta`;
const ROLE_REFUSED = 'The direct link cannot be turned on: the direct link signer must be a signer.';

test.describe.configure({ mode: 'serial', timeout: 900_000 });

const messageOf = async (response: APIResponse) => {
  const text = await response.text();

  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
};

/** A V2 template whose direct link is OFF; its direct signer has one unconditional signature field. */
const seedOffTemplate = async () => {
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: `Task Q ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });

  if (!template.directLink) {
    throw new Error('no direct link');
  }

  await prisma.templateDirectLink.update({ where: { id: template.directLink.id }, data: { enabled: false } });

  const recipientId = template.directLink.directTemplateRecipientId;
  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });
  const signature = await prisma.field.findFirstOrThrow({
    where: { envelopeId: template.id, type: FieldType.SIGNATURE },
  });
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'q', expiresIn: null });

  return {
    template,
    templateId: mapSecondaryIdToTemplateId(template.secondaryId),
    link: template.directLink,
    recipient,
    signature,
    token,
  };
};

const api = (request: APIRequestContext, token: string) => ({
  toggle: async (templateId: number, enabled: boolean) =>
    await request.post(`${V2}/template/direct/toggle`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { templateId, enabled },
    }),
  role: async (envelopeId: string, recipient: { id: number; email: string; name: string }, role: RecipientRole) =>
    await request.post(`${V2}/envelope/recipient/update-many`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { envelopeId, data: [{ id: recipient.id, role, email: recipient.email, name: recipient.name }] },
    }),
  deleteField: async (fieldId: number) =>
    await request.post(`${V2}/envelope/field/delete`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { fieldId },
    }),
});

/** Broken: the link is on and a visitor cannot use it. */
const isBroken = async (linkId: string, recipientId: number) => {
  const link = await prisma.templateDirectLink.findUniqueOrThrow({ where: { id: linkId } });

  if (!link.enabled) {
    return false;
  }

  const signer = await prisma.recipient.findUnique({ where: { id: recipientId } });
  const fixed = (await prisma.field.findMany({ where: { recipientId, type: FieldType.SIGNATURE } })).filter(
    (field) => !(field.fieldMeta as { condition?: unknown } | null)?.condition,
  );

  return !signer || signer.role !== RecipientRole.SIGNER || fixed.length === 0;
};

test('Q-1: turning the link on refuses a signer that is not a SIGNER, or has no signature field', async ({
  request,
}) => {
  const { template, templateId, link, recipient, signature, token } = await seedOffTemplate();
  const calls = api(request, token);

  for (const role of [RecipientRole.VIEWER, RecipientRole.APPROVER]) {
    expect((await calls.role(template.id, recipient, role)).ok(), role).toBe(true);

    const on = await calls.toggle(templateId, true);
    expect(on.status(), role).toBe(400);
    expect(await messageOf(on)).toBe(`${ROLE_REFUSED} Change their role back to signer first.`);
    expect((await prisma.templateDirectLink.findUniqueOrThrow({ where: { id: link.id } })).enabled).toBe(false);
  }

  // Repaired: back to SIGNER, then the link turns on.
  expect((await calls.role(template.id, recipient, RecipientRole.SIGNER)).ok()).toBe(true);

  // Making the signer a VIEWER removed their signature field (upstream). With no signature field
  // the link is refused too.
  expect(await prisma.field.count({ where: { id: signature.id } })).toBe(0);
  const noSignature = await calls.toggle(templateId, true);
  expect(noSignature.status()).toBe(400);
  expect(await messageOf(noSignature)).toMatch(/signature field without a condition/);
  expect(await messageOf(noSignature)).not.toMatch(/ST_DIRECT_LINK|P0001/);
});

test('Q-1: 100 races through the routes (role change or signature delete vs link on), 0 broken', async ({
  request,
}) => {
  const broken: number[] = [];
  const unexpected: string[] = [];

  for (let round = 0; round < 100; round++) {
    const { template, templateId, link, recipient, signature, token } = await seedOffTemplate();
    const calls = api(request, token);

    const responses = await Promise.all([
      round % 2 === 0 ? calls.role(template.id, recipient, RecipientRole.VIEWER) : calls.deleteField(signature.id),
      calls.toggle(templateId, true),
    ]);

    for (const response of responses) {
      if (response.status() >= 500) {
        unexpected.push(`round ${round}: ${response.status()} ${(await messageOf(response)).slice(0, 120)}`);
      }
    }

    if (await isBroken(link.id, recipient.id)) {
      broken.push(round);
    }
  }

  expect(broken).toEqual([]);
  expect(unexpected).toEqual([]);
});

test('Q-1: 100 races straight in SQL on two connections, 0 broken', async () => {
  const url = process.env.NEXT_PRIVATE_DATABASE_URL;
  test.skip(!url, 'needs NEXT_PRIVATE_DATABASE_URL');

  const a = new pg.Client({ connectionString: url });
  const b = new pg.Client({ connectionString: url });
  await a.connect();
  await b.connect();

  const broken: number[] = [];
  let refused = 0;

  try {
    for (let round = 0; round < 100; round++) {
      const { link, recipient, signature } = await seedOffTemplate();

      await a.query('BEGIN');
      await b.query('BEGIN');

      if (round % 2 === 0) {
        await a.query(`UPDATE "Recipient" SET "role" = 'VIEWER' WHERE "id" = $1`, [recipient.id]);
      } else {
        await a.query('DELETE FROM "Field" WHERE "id" = $1', [signature.id]);
      }

      await b.query('UPDATE "TemplateDirectLink" SET "enabled" = true WHERE "id" = $1', [link.id]);

      const results = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')]);
      refused += results.filter((result) => result.status === 'rejected').length;

      if (await isBroken(link.id, recipient.id)) {
        broken.push(round);
      }
    }
  } finally {
    await a.end();
    await b.end();
  }

  expect(broken).toEqual([]);
  // In every round one of the two must give way.
  expect(refused).toBe(100);
});

test('Q-1: a link that is already on and broken stays editable, repairable and deletable', async ({ request }) => {
  const url = process.env.NEXT_PRIVATE_DATABASE_URL;
  test.skip(!url, 'needs NEXT_PRIVATE_DATABASE_URL');

  const { template, templateId, link, recipient, token } = await seedOffTemplate();
  const calls = api(request, token);

  // The broken state made before these checks: triggers off for this one session.
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("SET session_replication_role = 'replica'");
  await admin.query(`UPDATE "Recipient" SET "role" = 'VIEWER' WHERE "id" = $1`, [recipient.id]);
  await admin.query('UPDATE "TemplateDirectLink" SET "enabled" = true WHERE "id" = $1', [link.id]);
  await admin.end();
  expect(await isBroken(link.id, recipient.id)).toBe(true);

  // Unrelated updates of the link row (the token) and "on" again are not blocked.
  await prisma.templateDirectLink.update({ where: { id: link.id }, data: { token: `q-${Date.now()}` } });
  expect((await calls.toggle(templateId, true)).status()).not.toBe(500);

  // Repairable: the role back to SIGNER while the link is on.
  expect((await calls.role(template.id, recipient, RecipientRole.SIGNER)).ok()).toBe(true);
  expect(await isBroken(link.id, recipient.id)).toBe(false);

  // Deleting the link and the template is never blocked.
  const deleteLink = await request.post(`${V2}/template/direct/delete`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { templateId },
  });
  expect(deleteLink.ok(), await deleteLink.text()).toBe(true);

  const deleteTemplate = await request.post(`${V2}/envelope/delete`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId: template.id },
  });
  expect(deleteTemplate.ok(), await deleteTemplate.text()).toBe(true);
});

test('Q-1: creating a new link on a template with a placeholder signer still works', async ({ request }) => {
  const context = await apiCreateTestContext('q-new-link');
  const { envelope } = await apiSeedTemplate(request, {
    context,
    recipients: [{ email: 'q-signer@example.com', name: 'Sam Rivera', role: 'SIGNER' }],
  });

  // Upstream makes a new placeholder signer with no fields; the sender adds fields after.
  const create = await request.post(`${V2}/template/direct/create`, {
    headers: { Authorization: `Bearer ${context.token}` },
    data: { templateId: mapSecondaryIdToTemplateId(envelope.secondaryId) },
  });

  expect(create.ok(), await create.text()).toBe(true);
});

/* -------------------------------------------------------------------------- */
/*                Q-3: API v1 routes by legacy number act on the right object  */
/* -------------------------------------------------------------------------- */

test('Q-3: a v1 document route never acts on a template that shares the legacy number', async ({ request }) => {
  const context = await apiCreateTestContext('q3');

  // A draft document with one signer and a text field, made through the API.
  const { envelope: document } = await apiSeedDraftDocument(request, {
    context,
    recipients: [{ email: `q3-${Date.now()}@example.com`, name: 'Sam Rivera' }],
    fieldsPerRecipient: [
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 },
        { type: FieldType.TEXT, page: 1, positionX: 10, positionY: 40, width: 20, height: 5 },
      ],
    ],
  });
  // A template of the same team, link on. Both get the same legacy number, unused so far: a
  // document "document_<n>" and a template "template_<n>" (separate counters, so it happens).
  const template = await seedDirectTemplate({
    title: 'Q3 template',
    userId: context.user.id,
    teamId: context.team.id,
    internalVersion: 2,
  });
  const legacyNumber = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  await prisma.envelope.update({ where: { id: document.id }, data: { secondaryId: `document_${legacyNumber}` } });
  await prisma.envelope.update({ where: { id: template.id }, data: { secondaryId: `template_${legacyNumber}` } });

  const templateField = await prisma.field.findFirstOrThrow({
    where: { envelopeId: template.id, type: FieldType.SIGNATURE },
  });
  const templateRecipient = template.directLink!.directTemplateRecipientId;
  const headers = { Authorization: `Bearer ${context.token}` };

  const deleteField = await request.delete(`${BASE}/api/v1/documents/${legacyNumber}/fields/${templateField.id}`, {
    headers,
    data: {},
  });
  expect(deleteField.status()).toBe(404);
  expect(await messageOf(deleteField)).toBe('Field not found');

  const updateField = await request.patch(`${BASE}/api/v1/documents/${legacyNumber}/fields/${templateField.id}`, {
    headers,
    data: {
      recipientId: templateRecipient,
      type: 'SIGNATURE',
      pageNumber: 1,
      pageX: 1,
      pageY: 1,
      pageWidth: 5,
      pageHeight: 5,
    },
  });
  expect(updateField.status()).toBe(404);

  const deleteRecipient = await request.delete(
    `${BASE}/api/v1/documents/${legacyNumber}/recipients/${templateRecipient}`,
    { headers, data: {} },
  );
  expect(deleteRecipient.status()).toBe(404);
  expect(await messageOf(deleteRecipient)).toBe('Recipient not found');

  // Nothing of the template changed.
  expect(await prisma.field.count({ where: { id: templateField.id } })).toBe(1);
  expect(await prisma.recipient.count({ where: { id: templateRecipient } })).toBe(1);

  // The document's own field is still deleted as before.
  const ownField = await prisma.field.findFirstOrThrow({ where: { envelopeId: document.id, type: FieldType.TEXT } });
  const own = await request.delete(`${BASE}/api/v1/documents/${legacyNumber}/fields/${ownField.id}`, {
    headers,
    data: {},
  });
  expect(own.ok(), await own.text()).toBe(true);
});

/* -------------------------------------------------------------------------- */
/*            Q-4: API v1 add-recipient leaves existing recipients alone       */
/* -------------------------------------------------------------------------- */

test('Q-4: adding a recipient through API v1 on a sent document leaves the first signer untouched', async ({
  page,
  request,
}) => {
  const context = await apiCreateTestContext('q4');
  const signerEmail = `q4-${Date.now()}@example.com`;
  const { envelope } = await apiSeedPendingDocument(request, {
    context,
    recipients: [{ email: signerEmail, name: 'Sam Rivera' }],
    fieldsPerRecipient: [
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 },
        { type: FieldType.TEXT, page: 1, positionX: 10, positionY: 40, width: 20, height: 5 },
      ],
    ],
  });

  const snapshot = async () => {
    const recipient = await prisma.recipient.findFirstOrThrow({
      where: { envelopeId: envelope.id, email: signerEmail },
    });
    const fields = await prisma.field.findMany({ where: { recipientId: recipient.id }, orderBy: { id: 'asc' } });

    return JSON.stringify({ recipient, fields });
  };

  await expect
    .poll(async () => (await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } })).sendStatus, {
      timeout: 60_000,
    })
    .toBe('SENT');

  const before = await snapshot();
  const first = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id, email: signerEmail } });
  const documentId = Number(
    (await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).secondaryId.replace('document_', ''),
  );

  const added = await request.post(`${BASE}/api/v1/documents/${documentId}/recipients`, {
    headers: { Authorization: `Bearer ${context.token}` },
    data: { name: 'Jordan Lee', email: `q4-second-${Date.now()}@example.com`, role: 'SIGNER' },
  });
  expect(added.ok(), await added.text()).toBe(true);

  // Byte-identical: id, token, send and signing status, every field.
  expect(await snapshot()).toBe(before);
  expect(await prisma.recipient.count({ where: { envelopeId: envelope.id } })).toBe(2);

  // The emailed link still opens and signs.
  const open = await page.goto(`${BASE}/sign/${first.token}`);
  expect(open?.status()).toBe(200);
  await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });

  const text = await prisma.field.findFirstOrThrow({ where: { recipientId: first.id, type: FieldType.TEXT } });
  const sign = await request.post(`${BASE}/api/trpc/envelope.field.sign`, {
    headers: { 'content-type': 'application/json', Origin: BASE },
    data: JSON.stringify({
      json: { token: first.token, fieldId: text.id, fieldValue: { type: 'TEXT', value: 'Hello' } },
    }),
  });
  expect(sign.ok(), await sign.text()).toBe(true);

  // A completed or cancelled document: a plain 400.
  for (const status of ['COMPLETED', 'REJECTED'] as const) {
    await prisma.envelope.update({ where: { id: envelope.id }, data: { status } });
    const refused = await request.post(`${BASE}/api/v1/documents/${documentId}/recipients`, {
      headers: { Authorization: `Bearer ${context.token}` },
      data: { name: 'Late', email: `q4-late-${Date.now()}@example.com`, role: 'SIGNER' },
    });
    expect(refused.status(), status).toBe(400);
  }
});
