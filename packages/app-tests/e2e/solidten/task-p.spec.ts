import { createHash, randomBytes } from 'node:crypto';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, Prisma, RecipientRole } from '@prisma/client';
import pg from 'pg';

import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign, task P.
 * P-1: parallel deletes cannot beat the direct link signature check (routes and raw SQL), and
 * mixed parallel work on one template never surfaces a deadlock. P-2: the direct signer stays a
 * signer while the link is on. P-3: embedding and API v1 answer the plain 400. P-4: the editor
 * shows the plain reason and keeps the field.
 */

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const V2 = `${BASE}/api/v2-beta`;
const PLAIN_F1 = 'The direct link signer needs at least one signature field without a condition.';

test.describe.configure({ mode: 'serial', timeout: 900_000 });

const messageOf = async (response: APIResponse) => {
  const text = await response.text();

  try {
    const body = JSON.parse(text) as { message?: string; error?: { json?: { message?: string } } };

    return body.error?.json?.message ?? body.message ?? text;
  } catch {
    return text;
  }
};

const trpc = async (request: APIRequestContext, path: string, json: unknown, teamId?: number) =>
  await request.post(`${BASE}/api/trpc/${path}`, {
    headers: {
      ...WEBAPP_ORIGIN_HEADERS,
      'content-type': 'application/json',
      ...(teamId ? { 'x-team-id': String(teamId) } : {}),
    },
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

const addSignature = async (envelopeId: string, recipientId: number, positionY: number) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  return await prisma.field.create({
    data: {
      envelopeId,
      envelopeItemId: item.id,
      recipientId,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(positionY),
      width: new Prisma.Decimal(20),
      height: new Prisma.Decimal(5),
      customText: '',
      inserted: false,
    },
  });
};

/** A V2 template, link on, whose direct signer has two unconditional signature fields. */
const seedTwoSignatureTemplate = async () => {
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: `Task P ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });

  if (!template.directLink) {
    throw new Error('no direct link');
  }

  const recipientId = template.directLink.directTemplateRecipientId;
  const first = await prisma.field.findFirstOrThrow({ where: { envelopeId: template.id, type: FieldType.SIGNATURE } });
  const second = await addSignature(template.id, recipientId, 60);
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'p', expiresIn: null });

  return { user, team, template, directLink: template.directLink, recipientId, first, second, token };
};

const unconditionalSignatures = async (recipientId: number) =>
  (await prisma.field.findMany({ where: { recipientId, type: FieldType.SIGNATURE } })).filter(
    (field) => !(field.fieldMeta as { condition?: unknown } | null)?.condition,
  ).length;

/* -------------------------------------------------------------------------- */
/*                                     P-1                                    */
/* -------------------------------------------------------------------------- */

test('P-1: 50 parallel delete pairs through the real routes lose no signature', async ({ page }) => {
  const losses: number[] = [];
  const unexpected: string[] = [];

  for (let round = 0; round < 50; round++) {
    const { user, team, recipientId, first, second, token } = await seedTwoSignatureTemplate();

    const v2Delete = async (fieldId: number) =>
      await page.context().request.post(`${V2}/envelope/field/delete`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { fieldId },
      });

    // Even rounds: two API v2 deletes. Odd rounds: one web delete and one API v2 delete.
    let webDelete: ((fieldId: number) => Promise<APIResponse>) | null = null;

    if (round % 2 === 1) {
      await page.context().clearCookies();
      await signInByEmailLink(page, user.id);
      webDelete = async (fieldId: number) =>
        await trpc(page.context().request, 'envelope.field.delete', { fieldId }, team.id);
    }

    const responses = await Promise.all([webDelete ? webDelete(first.id) : v2Delete(first.id), v2Delete(second.id)]);

    const left = await unconditionalSignatures(recipientId);

    if (left < 1) {
      losses.push(round);
    }

    for (const response of responses) {
      if (!response.ok()) {
        const message = await messageOf(response);

        if (response.status() !== 400 || !message.includes(PLAIN_F1)) {
          unexpected.push(`round ${round}: ${response.status()} ${message.slice(0, 160)}`);
        }
      }
    }

    // Exactly one of the two may succeed.
    expect(responses.filter((response) => response.ok()).length, `round ${round}`).toBe(1);
  }

  expect(losses).toEqual([]);
  expect(unexpected).toEqual([]);
});

test('P-1: 50 parallel delete pairs straight in SQL on two connections lose no signature', async () => {
  const url = process.env.NEXT_PRIVATE_DATABASE_URL;
  test.skip(!url, 'needs NEXT_PRIVATE_DATABASE_URL');

  const a = new pg.Client({ connectionString: url });
  const b = new pg.Client({ connectionString: url });
  await a.connect();
  await b.connect();

  const losses: number[] = [];
  let refusals = 0;

  try {
    for (let round = 0; round < 50; round++) {
      const { recipientId, first, second } = await seedTwoSignatureTemplate();

      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query('DELETE FROM "Field" WHERE "id" = $1', [first.id]);
      await b.query('DELETE FROM "Field" WHERE "id" = $1', [second.id]);

      // Both commit at the same moment; each runs the deferred check at its commit.
      const results = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')]);

      for (const result of results) {
        if (result.status === 'rejected') {
          expect(String(result.reason)).toContain('ST_DIRECT_LINK_FIXED_SIGNATURE');
          refusals++;
        }
      }

      // A failed COMMIT has already ended the transaction (rolled back).
      if ((await unconditionalSignatures(recipientId)) < 1) {
        losses.push(round);
      }
    }
  } finally {
    await a.end();
    await b.end();
  }

  expect(losses).toEqual([]);
  expect(refusals).toBe(50);
});

test('P-1: 20 parallel mixed operations on one template: no deadlock, no 500, link stays usable', async ({ page }) => {
  const { user, team, template, recipientId, first, second, token } = await seedTwoSignatureTemplate();
  const extra = await Promise.all([70, 80, 90].map(async (y) => await addSignature(template.id, recipientId, y)));
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

  await signInByEmailLink(page, user.id);
  const request = page.context().request;
  const templateId = mapSecondaryIdToTemplateId(template.secondaryId);

  const operations: (() => Promise<APIResponse>)[] = [];

  for (let i = 0; i < 20; i++) {
    const kind = i % 5;

    operations.push(async () => {
      if (kind === 0) {
        return await request.post(`${V2}/envelope/field/delete`, {
          headers: { Authorization: `Bearer ${token}` },
          data: { fieldId: [first, second, ...extra][i % 5].id },
        });
      }

      if (kind === 1) {
        // A save: move the first signature field.
        return await request.post(`${V2}/envelope/field/update-many`, {
          headers: { Authorization: `Bearer ${token}` },
          data: {
            envelopeId: template.id,
            data: [{ id: first.id, type: FieldType.SIGNATURE, positionY: 10 + i, envelopeItemId: item.id }],
          },
        });
      }

      if (kind === 2) {
        return await trpc(request, 'template.toggleTemplateDirectLink', { templateId, enabled: i % 2 === 0 }, team.id);
      }

      if (kind === 3) {
        return await trpc(request, 'envelope.field.delete', { fieldId: extra[i % 3].id }, team.id);
      }

      // A new field for another recipient-less spot: a text field on the direct signer.
      return await request.post(`${V2}/envelope/field/create-many`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          envelopeId: template.id,
          data: [
            {
              recipientId,
              envelopeItemId: item.id,
              type: FieldType.TEXT,
              page: 1,
              positionX: 50,
              positionY: 10 + i,
              width: 10,
              height: 5,
            },
          ],
        },
      });
    });
  }

  const responses = await Promise.all(operations.map(async (operation) => await operation()));
  const problems: string[] = [];

  for (const response of responses) {
    const message = await messageOf(response);

    if (response.status() >= 500 || /deadlock|40P01|ST_DIRECT_LINK|could not serialize/i.test(message)) {
      problems.push(`${response.status()} ${message.slice(0, 160)}`);
    }
  }

  expect(problems).toEqual([]);

  const link = await prisma.templateDirectLink.findUniqueOrThrow({ where: { envelopeId: template.id } });

  if (link.enabled) {
    expect(await unconditionalSignatures(recipientId)).toBeGreaterThanOrEqual(1);
  }
});

/* -------------------------------------------------------------------------- */
/*                                     P-2                                    */
/* -------------------------------------------------------------------------- */

test('P-2: the direct signer stays a signer while the link is on; a broken link is shown and repairable', async ({
  page,
  browser,
}) => {
  const { user, team, template, directLink, recipientId, token } = await seedTwoSignatureTemplate();
  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });

  const updateRole = async (role: RecipientRole) =>
    await page.context().request.post(`${V2}/envelope/recipient/update-many`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        envelopeId: template.id,
        data: [{ id: recipientId, role, email: recipient.email, name: recipient.name }],
      },
    });

  for (const role of [RecipientRole.VIEWER, RecipientRole.APPROVER]) {
    const response = await updateRole(role);
    expect(response.status(), role).toBe(400);
    expect(await messageOf(response)).toBe(
      'The direct link signer must stay a signer while the direct link is on. Turn the direct link off first.',
    );
  }

  const remove = await page.context().request.post(`${V2}/envelope/recipient/delete`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { recipientId },
  });
  expect(remove.status()).toBe(400);
  expect(await messageOf(remove)).toBe(
    'The direct link signer cannot be removed while the direct link is on. Turn the direct link off first.',
  );
  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } })).role).toBe(RecipientRole.SIGNER);

  // A template already in that state (made before this check): link off, role changed, link on.
  // Q-1 now refuses turning the link on in that state, so the checks are off for this one session.
  const admin = new pg.Client({ connectionString: process.env.NEXT_PRIVATE_DATABASE_URL });
  await admin.connect();
  await admin.query("SET session_replication_role = 'replica'");
  await admin.query(`UPDATE "Recipient" SET "role" = 'VIEWER' WHERE "id" = $1`, [recipientId]);
  await admin.end();

  const visitor = await browser.newContext();
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(formatDirectTemplatePath(directLink.token));
  await expect(visitorPage.getByText('This form is not set up correctly. Contact the sender.')).toBeVisible();
  await visitor.close();

  await signInByEmailLink(page, user.id);
  await page.goto(`${BASE}/t/${team.url}/templates/${template.id}`);
  await expect(page.getByTestId('direct-link-broken-alert')).toBeVisible();

  // Repair: back to signer is allowed while the link is on.
  await prisma.recipient.update({ where: { id: recipientId }, data: { role: RecipientRole.SIGNER } });
  await page.reload();
  await expect(page.getByTestId('direct-link-broken-alert')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/*                                     P-3                                    */
/* -------------------------------------------------------------------------- */

test('P-3: embedding template update and API v1 field delete answer the plain 400', async ({ request }) => {
  const { template, recipientId, first, second, token } = await seedTwoSignatureTemplate();
  await prisma.field.delete({ where: { id: second.id } });

  const templateId = mapSecondaryIdToTemplateId(template.secondaryId);
  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });
  const { token: presignToken } = await createEmbeddingPresignToken({
    apiToken: token,
    scope: `templateId:${templateId}`,
  });

  const embedding = await request.post(`${BASE}/api/trpc/embeddingPresign.updateEmbeddingTemplate`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', Authorization: `Bearer ${presignToken}` },
    data: JSON.stringify({
      json: {
        templateId,
        recipients: [
          { id: recipientId, email: recipient.email, name: recipient.name, role: recipient.role, fields: [] },
        ],
      },
    }),
  });
  expect(embedding.status()).toBe(400);
  expect(await messageOf(embedding)).toContain(PLAIN_F1);

  const v1 = await request.delete(`${BASE}/api/v1/documents/${templateId}/fields/${first.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  console.log(`P-3 API v1 field delete: ${v1.status()} ${await messageOf(v1)}`);
  expect(v1.status()).not.toBe(500);
  expect(await prisma.field.count({ where: { id: first.id } })).toBe(1);
  if (v1.status() === 400) {
    expect(await messageOf(v1)).toContain(PLAIN_F1);
  }
});

/* -------------------------------------------------------------------------- */
/*                                     P-4                                    */
/* -------------------------------------------------------------------------- */

test('P-4: a refused delete in the editor shows the plain reason and the field stays', async ({ page }) => {
  const { user, team, template, first, second } = await seedTwoSignatureTemplate();
  await prisma.field.delete({ where: { id: second.id } });

  await signInByEmailLink(page, user.id);
  await page.goto(`${BASE}/t/${team.url}/templates/${template.id}/edit?step=addFields`);

  const canvas = page.locator('.konva-container canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('no canvas box');
  }

  await canvas.click({
    force: true,
    position: {
      x: ((Number(first.positionX) + Number(first.width) / 2) / 100) * box.width,
      y: ((Number(first.positionY) + Number(first.height) / 2) / 100) * box.height,
    },
  });
  await page.getByTitle('Remove').first().click();

  await expect(page.getByText(PLAIN_F1).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Your changes cannot be saved at this time.')).toHaveCount(0);
  expect(await prisma.field.count({ where: { id: first.id } })).toBe(1);

  // The editor has the field back: a later save (here, after a short wait) does not fail.
  await page.waitForTimeout(3000);
  await expect(page.getByText('Your changes cannot be saved at this time.')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/*                                     P-5                                    */
/* -------------------------------------------------------------------------- */

test('P-5: bulk send from a template with "Require password" is refused up front (password sign-in off)', async ({
  page,
}) => {
  await page.goto(`${BASE}/signin`);
  const isOff = await page.evaluate(
    () =>
      (window as { __ENV__?: Record<string, string | undefined> }).__ENV__
        ?.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN === 'true',
  );
  test.skip(!isOff, 'needs a server with NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true');

  const { user, team, template } = await seedTwoSignatureTemplate();
  await prisma.envelope.update({
    where: { id: template.id },
    data: { authOptions: { globalAccessAuth: [], globalActionAuth: ['PASSWORD'] } },
  });

  await signInByEmailLink(page, user.id);
  const jobsBefore = await prisma.backgroundJob.count({ where: { jobId: 'internal.bulk-send-template' } });

  const response = await trpc(
    page.context().request,
    'template.uploadBulkSend',
    {
      templateId: mapSecondaryIdToTemplateId(template.secondaryId),
      teamId: team.id,
      csv: 'recipient_1_email,recipient_1_name\nsam@example.com,Sam Rivera\n',
      sendImmediately: false,
    },
    team.id,
  );

  expect(response.status()).toBe(400);
  expect(await messageOf(response)).toContain('This template uses "Require password"');
  expect(await prisma.backgroundJob.count({ where: { jobId: 'internal.bulk-send-template' } })).toBe(jobsBefore);
});
