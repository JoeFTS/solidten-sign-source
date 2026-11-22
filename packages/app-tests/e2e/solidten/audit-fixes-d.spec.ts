import { execFile } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Regression tests for the 11/21 audit round 2, builder D (tokens, visibility, retention,
 * job slots). Each test reproduces the verifier's steps and fails on `solidten/main`
 * before the fix.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { run as runExecuteWebhook } from '@documenso/lib/jobs/definitions/internal/execute-webhook.handler';
import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { applyRetentionToEnvelope } from '@documenso/lib/server-only/retention/apply-retention';
import { createTeam } from '@documenso/lib/server-only/team/create-team';
import { getTeamSettings } from '@documenso/lib/server-only/team/get-team-settings';
import { nanoid } from '@documenso/lib/universal/id';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument, seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedOrganisationMembers } from '@documenso/prisma/seed/organisations';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedBlankTemplate, seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Browser } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  DocumentStatus,
  DocumentVisibility,
  OrganisationMemberRole,
  TeamMemberRole,
  TemplateType,
  WebhookCallStatus,
} from '@prisma/client';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

/** A signed-in browser of one user (its own cookie jar). */
const signedIn = async (browser: Browser, email: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await apiSignin({ page, email });

  return { context, page, request: context.request };
};

const trpcGet = async (requestContext: APIRequestContext, path: string, input: unknown, teamId: number) =>
  await requestContext.get(
    `${WEBAPP_BASE_URL}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
    { headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(teamId) } },
  );

const trpcPost = async (requestContext: APIRequestContext, path: string, input: unknown, teamId: number) =>
  await requestContext.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(teamId) },
    data: JSON.stringify({ json: input }),
  });

const seedEnvelopeWithItem = async (user: Parameters<typeof seedBlankDocument>[0], teamId: number) => {
  const envelope = await seedBlankDocument(user, teamId, { internalVersion: 2 });

  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  return { envelope, item };
};

/** The two presign file read routes: the item view (?token=) and item.pdf (?presignToken=). */
const readWithPresign = async (
  request: APIRequestContext,
  target: Awaited<ReturnType<typeof seedEnvelopeWithItem>>,
  presignToken: string,
) => {
  const { envelope, item } = target;

  const view = await request.get(
    `${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/envelopeItem/${item.id}?token=${presignToken}`,
  );

  const pdf = await request.get(
    `${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/envelopeItem/${item.id}/dataId/${item.documentDataId}/initial/item.pdf?presignToken=${presignToken}`,
  );

  return [view.status(), pdf.status()];
};

/* -------------------------------------------------------------------------- */
/*                                   AUD-21                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-21]: a presign token reads files only of its own team and of the envelope it is scoped to', async ({
  request,
}) => {
  const { user, team: teamA, organisation } = await seedUser();

  const teamBUrl = `team-${nanoid()}`;

  await createTeam({
    userId: user.id,
    teamName: 'Team B',
    teamUrl: teamBUrl,
    organisationId: organisation.id,
    inheritMembers: true,
  });

  const teamB = await prisma.team.findFirstOrThrow({ where: { url: teamBUrl } });

  const teamAEnvelope = await seedEnvelopeWithItem(user, teamA.id);
  const scopedEnvelope = await seedEnvelopeWithItem(user, teamB.id);
  const otherTeamBEnvelope = await seedEnvelopeWithItem(user, teamB.id);

  const { token: apiToken } = await createApiToken({
    userId: user.id,
    teamId: teamB.id,
    tokenName: 'audit-d-presign',
    expiresIn: null,
  });

  const { token: scoped } = await createEmbeddingPresignToken({
    apiToken,
    scope: `envelopeId:${scopedEnvelope.envelope.id}`,
  });

  expect(await readWithPresign(request, scopedEnvelope, scoped)).toEqual([200, 200]);
  expect(await readWithPresign(request, otherTeamBEnvelope, scoped)).not.toContain(200);
  expect(await readWithPresign(request, teamAEnvelope, scoped)).not.toContain(200);

  // The legacy v1 scope form still reaches its own document.
  const { token: legacyScoped } = await createEmbeddingPresignToken({
    apiToken,
    scope: `documentId:${mapSecondaryIdToDocumentId(otherTeamBEnvelope.envelope.secondaryId)}`,
  });

  expect(await readWithPresign(request, otherTeamBEnvelope, legacyScoped)).toEqual([200, 200]);
  expect(await readWithPresign(request, scopedEnvelope, legacyScoped)).not.toContain(200);

  // An unscoped token reaches its own team, never the other team of the same user.
  const { token: unscoped } = await createEmbeddingPresignToken({ apiToken });

  expect(await readWithPresign(request, otherTeamBEnvelope, unscoped)).toEqual([200, 200]);
  expect(await readWithPresign(request, teamAEnvelope, unscoped)).not.toContain(200);
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-35                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-35]: a presign token stops working when its API token expires or its user is disabled', async ({
  request,
}) => {
  const { user, team } = await seedUser();

  const target = await seedEnvelopeWithItem(user, team.id);

  const { token: apiToken } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'audit-d-revoked',
    expiresIn: null,
  });

  const { token: presign } = await createEmbeddingPresignToken({ apiToken, expiresIn: 60 });

  expect(await readWithPresign(request, target, presign)).toEqual([200, 200]);

  const storedToken = await prisma.apiToken.findFirstOrThrow({ where: { teamId: team.id, name: 'audit-d-revoked' } });

  await prisma.apiToken.update({ where: { id: storedToken.id }, data: { expires: new Date(Date.now() - 1000) } });

  expect(await readWithPresign(request, target, presign)).not.toContain(200);

  await prisma.apiToken.update({ where: { id: storedToken.id }, data: { expires: null } });

  expect(await readWithPresign(request, target, presign)).toEqual([200, 200]);

  // Disabling the user (the admin action) is the other revocation event.
  await prisma.user.update({ where: { id: user.id }, data: { disabled: true } });

  expect(await readWithPresign(request, target, presign)).not.toContain(200);
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-29                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-29]: the form response list and CSV show a member only the responses whose document they may see', async ({
  browser,
}) => {
  const { owner, team } = await seedTeam();
  const member = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MEMBER });

  const template = await seedDirectTemplate({
    title: `Audit D form ${Date.now()}`,
    userId: owner.id,
    teamId: team.id,
    internalVersion: 2,
  });

  if (!template.directLink) {
    throw new Error('Seeded template has no direct link');
  }

  const form = await prisma.stPublicForm.create({ data: { directLinkId: template.directLink.id } });

  const respond = async (visibility: DocumentVisibility, submitterEmail: string) => {
    const envelope = await seedBlankDocument(owner, team.id, {
      internalVersion: 2,
      createDocumentOptions: { visibility },
    });

    await prisma.stPublicFormSubmission.create({
      data: { formId: form.id, envelopeId: envelope.id, submitterEmail, submitterName: 'Visitor', emailVerified: true },
    });
  };

  const hiddenEmail = `hidden-${nanoid()}@test.documenso.com`;
  const openEmail = `open-${nanoid()}@test.documenso.com`;

  await respond(DocumentVisibility.ADMIN, hiddenEmail);
  await respond(DocumentVisibility.EVERYONE, openEmail);

  const listAs = async (email: string) => {
    const session = await signedIn(browser, email);

    const list = await trpcGet(session.request, 'publicForm.findResponses', { envelopeId: template.id }, team.id);
    expect(list.ok(), await list.text()).toBe(true);

    const exported = await trpcPost(
      session.request,
      'publicForm.exportResponses',
      { envelopeId: template.id },
      team.id,
    );
    expect(exported.ok(), await exported.text()).toBe(true);

    const page = (await list.json()).result.data.json;
    const csv: string = (await exported.json()).result.data.json.csv;

    await session.context.close();

    return {
      emails: page.data.map((row: { submitterEmail: string }) => row.submitterEmail).sort(),
      count: page.count,
      totalCount: page.totalCount,
      csv,
    };
  };

  const asMember = await listAs(member.email);

  expect(asMember.emails).toEqual([openEmail]);
  expect(asMember.count).toBe(1);
  expect(asMember.totalCount).toBe(1);
  expect(asMember.csv).toContain(openEmail);
  expect(asMember.csv).not.toContain(hiddenEmail);

  const asOwner = await listAs(owner.email);

  expect(asOwner.emails).toEqual([hiddenEmail, openEmail].sort());
  expect(asOwner.totalCount).toBe(2);
  expect(asOwner.csv).toContain(hiddenEmail);
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-32                                   */
/* -------------------------------------------------------------------------- */

const DAY = 24 * 60 * 60 * 1000;

test('[AUD-32]: a purge removes the comment text from webhook logs, queued jobs and the form submission', async () => {
  const { user, team } = await seedUser();
  const now = new Date();

  const settings = { enabled: true, action: 'PURGE', days: 30, includeRejected: false, includeCancelled: false };

  // The rule as if an admin saved it long enough ago for a purge to run.
  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { retentionSettings: settings },
  });

  await prisma.stSettingsAuditLog.create({
    data: {
      organisationId: team.organisationId,
      teamId: team.id,
      setting: 'retentionSettings',
      newValue: settings,
      userEmail: 'seed@test.documenso.com',
      createdAt: new Date(now.getTime() - 8 * DAY),
    },
  });

  const target = await seedCompletedDocument(user, team.id, [`signer-${nanoid()}@test.documenso.com`], {
    internalVersion: 2,
    createDocumentOptions: { status: DocumentStatus.COMPLETED, completedAt: new Date(now.getTime() - 90 * DAY) },
  });

  const other = await seedBlankDocument(user, team.id, { internalVersion: 2 });

  const marker = `AUD32-PRIVATE-${nanoid()}`;
  const commentPayload = (envelopeId: string) => ({ id: 1, envelopeId, title: 'Doc', comment: { body: marker } });

  const webhook = await prisma.webhook.create({
    data: {
      webhookUrl: 'http://127.0.0.1:9/audit-d-hook',
      eventTriggers: ['DOCUMENT_COMMENT_CREATED'],
      userId: user.id,
      teamId: team.id,
    },
  });

  const storeCall = async (envelopeId: string) =>
    await prisma.webhookCall.create({
      data: {
        url: webhook.webhookUrl,
        event: 'DOCUMENT_COMMENT_CREATED',
        status: WebhookCallStatus.FAILED,
        requestBody: { event: 'DOCUMENT_COMMENT_CREATED', payload: commentPayload(envelopeId) },
        responseCode: 500,
        webhookId: webhook.id,
        // A retry the sweep would pick up after the purge.
        nextAttemptAt: new Date(now.getTime() + 60_000),
      },
    });

  await storeCall(target.id);

  // Same numeric payload id, other envelope: not part of the purge.
  const otherCall = await storeCall(other.id);

  const jobPayload = { event: 'DOCUMENT_COMMENT_CREATED', webhookId: webhook.id, data: commentPayload(target.id) };

  const queuedJob = await prisma.backgroundJob.create({
    data: { jobId: 'internal.execute-webhook', name: 'Execute Webhook', version: '1.0.0', payload: jobPayload },
  });

  const doneJob = await prisma.backgroundJob.create({
    data: {
      jobId: 'internal.execute-webhook',
      name: 'Execute Webhook',
      version: '1.0.0',
      payload: jobPayload,
      status: 'COMPLETED',
    },
  });

  const template = await seedDirectTemplate({ title: 'Audit D purge form', userId: user.id, teamId: team.id });

  if (!template.directLink) {
    throw new Error('Seeded template has no direct link');
  }

  const form = await prisma.stPublicForm.create({ data: { directLinkId: template.directLink.id } });

  await prisma.stPublicFormSubmission.create({
    data: {
      formId: form.id,
      envelopeId: target.id,
      submitterEmail: `visitor-${nanoid()}@test.documenso.com`,
      emailVerified: true,
    },
  });

  expect((await applyRetentionToEnvelope({ envelopeId: target.id, now, dryRun: false })).result).toBe('PURGED');

  const callsWithMarker = async () =>
    (
      await prisma.webhookCall.findMany({ where: { webhookId: webhook.id }, select: { id: true, requestBody: true } })
    ).filter((call) => JSON.stringify(call.requestBody).includes(marker));

  expect((await callsWithMarker()).map((call) => call.id)).toEqual([otherCall.id]);
  expect(await prisma.stPublicFormSubmission.count({ where: { envelopeId: target.id } })).toBe(0);
  expect(await prisma.backgroundJob.findUnique({ where: { id: queuedJob.id } })).toBeNull();
  expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: doneJob.id } })).payload).toBeNull();

  // A delivery that was already in flight when the purge ran is not sent, and logs nothing.
  const result = await runExecuteWebhook({
    payload: { event: 'DOCUMENT_COMMENT_CREATED', webhookId: webhook.id, data: commentPayload(target.id) },
    // biome-ignore lint/suspicious/noExplicitAny: the handler does not use its io.
    io: {} as any,
  });

  expect(result).toMatchObject({ skipped: true });
  expect((await callsWithMarker()).map((call) => call.id)).toEqual([otherCall.id]);
});

/* -------------------------------------------------------------------------- */
/*                     Retest e-scope 3: role change re-owns                  */
/* -------------------------------------------------------------------------- */

test('[AUD-20 follow-up]: a lower organisation role that removes team access hands the envelopes to the owner', async ({
  browser,
}) => {
  const { user: owner, organisation } = await seedUser();

  const closedTeamUrl = `team-${nanoid()}`;

  // A team that does not inherit members: an organisation MANAGER reaches it only through their role.
  await createTeam({
    userId: owner.id,
    teamName: 'Closed',
    teamUrl: closedTeamUrl,
    organisationId: organisation.id,
    inheritMembers: false,
  });

  const closedTeam = await prisma.team.findFirstOrThrow({ where: { url: closedTeamUrl } });

  const [manager] = await seedOrganisationMembers({
    members: [{ organisationRole: OrganisationMemberRole.MANAGER }],
    organisationId: organisation.id,
  });

  const envelope = await seedBlankDocument(manager, closedTeam.id, { internalVersion: 2 });

  // What the seal job resolves: it works while the manager reaches the team.
  await expect(getTeamSettings({ userId: manager.id, teamId: closedTeam.id })).resolves.toBeDefined();

  const managerMember = await prisma.organisationMember.findFirstOrThrow({
    where: { organisationId: organisation.id, userId: manager.id },
  });

  const session = await signedIn(browser, owner.email);

  const demoted = await trpcPost(
    session.request,
    'organisation.member.update',
    { organisationId: organisation.id, organisationMemberId: managerMember.id, data: { role: 'MEMBER' } },
    closedTeam.id,
  );

  expect(demoted.ok(), await demoted.text()).toBe(true);

  await session.context.close();

  await expect(getTeamSettings({ userId: manager.id, teamId: closedTeam.id })).rejects.toThrow('Team not found');

  const after = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

  expect(after.userId).toBe(owner.id);
  await expect(getTeamSettings({ userId: after.userId, teamId: closedTeam.id })).resolves.toBeDefined();
});

/* -------------------------------------------------------------------------- */
/*                Retest e-scope 4: organisation template files               */
/* -------------------------------------------------------------------------- */

test('[AUD-7 follow-up]: an organisation member outside the team gets an organisation template file only at a visibility they may see', async ({
  browser,
}) => {
  const { user: owner, organisation } = await seedUser();

  const closedTeamUrl = `team-${nanoid()}`;

  await createTeam({
    userId: owner.id,
    teamName: 'Closed',
    teamUrl: closedTeamUrl,
    organisationId: organisation.id,
    inheritMembers: false,
  });

  const closedTeam = await prisma.team.findFirstOrThrow({ where: { url: closedTeamUrl } });

  const [member] = await seedOrganisationMembers({
    members: [{ organisationRole: OrganisationMemberRole.MEMBER }],
    organisationId: organisation.id,
  });

  const seedOrganisationTemplate = async (visibility: DocumentVisibility) => {
    const template = await seedBlankTemplate(owner, closedTeam.id, {
      createTemplateOptions: { templateType: TemplateType.ORGANISATION, visibility },
    });

    return { envelope: template, item: template.envelopeItems[0] };
  };

  const adminOnly = await seedOrganisationTemplate(DocumentVisibility.ADMIN);
  const everyone = await seedOrganisationTemplate(DocumentVisibility.EVERYONE);

  const session = await signedIn(browser, member.email);

  const get = async ({ envelope, item }: Awaited<ReturnType<typeof seedOrganisationTemplate>>, path: string) =>
    (
      await session.request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/envelopeItem/${item.id}${path}`)
    ).status();

  for (const path of ['', '/download/original', `/dataId/${adminOnly.item.documentDataId}/initial/item.pdf`]) {
    expect(await get(adminOnly, path), path).not.toBe(200);
  }

  expect(await get(everyone, '')).toBe(200);
  expect(await get(everyone, '/download/original')).toBe(200);
  expect(await get(everyone, `/dataId/${everyone.item.documentDataId}/initial/item.pdf`)).toBe(200);

  await session.context.close();
});

/* -------------------------------------------------------------------------- */
/*                  Retest e-scope 5: share page of a deleted doc             */
/* -------------------------------------------------------------------------- */

test('[AUD-13 follow-up]: the share page of a deleted completed document shows nothing', async ({ request }) => {
  const { user, team } = await seedUser();

  const document = await seedCompletedDocument(user, team.id, [`signer-${nanoid()}@test.documenso.com`], {
    internalVersion: 2,
  });

  const qrToken = `qr_${nanoid()}`;
  const title = `Audit D shared ${nanoid()}`;

  await prisma.envelope.update({ where: { id: document.id }, data: { qrToken, title } });

  const shared = await request.get(`${WEBAPP_BASE_URL}/share/${qrToken}`, { maxRedirects: 0 });

  expect(shared.status()).toBe(200);
  expect(await shared.text()).toContain(title);

  await prisma.envelope.update({ where: { id: document.id }, data: { deletedAt: new Date() } });

  const deleted = await request.get(`${WEBAPP_BASE_URL}/share/${qrToken}`, { maxRedirects: 0 });

  expect(deleted.status()).not.toBe(200);
  expect(await deleted.text()).not.toContain(title);
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-25                                   */
/* -------------------------------------------------------------------------- */

test.describe('[AUD-25] webhook jobs and a stalled mail server', () => {
  test('webhook jobs to a silent receiver never hold every job slot', async () => {
    const { getJobConcurrency, withJobSlot } = await import('@documenso/lib/jobs/client/job-slots');

    let releaseWebhooks = () => {};
    const silentReceiver = new Promise<void>((resolve) => {
      releaseWebhooks = resolve;
    });

    try {
      // As many webhook deliveries as there are slots, each waiting on a receiver that never answers.
      const webhooks = Array.from({ length: getJobConcurrency() }, async (_, index) =>
        withJobSlot({ jobId: `audit-d-webhook-${index}`, definitionId: 'internal.execute-webhook' }, async () => {
          await silentReceiver;
        }),
      );

      const startedAt = Date.now();

      const seal = await Promise.race([
        withJobSlot({ jobId: 'audit-d-seal', definitionId: 'internal.seal-document' }, async () => 'sealed'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
      ]);

      expect(seal).toBe('sealed');
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      releaseWebhooks();
      await Promise.all(webhooks);
    } finally {
      releaseWebhooks();
      globalThis.__solidten_job_slots__ = undefined;
      globalThis.__solidten_receiver_job_slots__ = undefined;
    }
  });

  test('a mail server that accepts the connection but never greets fails the send in seconds', async () => {
    test.setTimeout(60_000);

    const { buildTransport } = await import('@documenso/email/transports/build-transport');

    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const transport = buildTransport({ type: 'SMTP_AUTH', host: '127.0.0.1', port, secure: false, ignoreTLS: true });

      const startedAt = Date.now();

      const outcome = await Promise.race([
        transport
          .sendMail({ from: 'a@test.documenso.com', to: 'b@test.documenso.com', subject: 'x', text: 'x' })
          .then(() => 'sent')
          .catch(() => 'failed'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20_000)),
      ]);

      expect(outcome).toBe('failed');
      expect(Date.now() - startedAt).toBeLessThan(20_000);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                     Hardening: production encryption keys                  */
/* -------------------------------------------------------------------------- */

test('[HARDEN-KEYS]: a production server refuses to start with a sample or repeated encryption key', async () => {
  const cryptoModule = path.join(__dirname, '../../../lib/constants/crypto.ts');

  const loadInProduction = async (primary: string, secondary: string) =>
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(cryptoModule)})`],
      {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          NEXT_PRIVATE_ENCRYPTION_KEY: primary,
          NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY: secondary,
        },
      },
    )
      .then(() => 'started')
      .catch((error: { stderr?: string }) => error.stderr ?? 'failed');

  expect(await loadInProduction('CAFEBABE', 'DEADBEEF')).toContain('will not start');
  expect(await loadInProduction('a7d2e9c4b1f04e8a', 'a7d2e9c4b1f04e8a')).toContain('will not start');
  expect(await loadInProduction('a7d2e9c4b1f04e8a', 'b3c1f0e2a9d84c7e')).toBe('started');
});

/* -------------------------------------------------------------------------- */
/*                      Hardening: legacy webhook trigger route               */
/* -------------------------------------------------------------------------- */

test('[HARDEN-WEBHOOK-ROUTE]: the legacy /api/webhook/trigger route is gone', async ({ request }) => {
  const response = await request.post(`${WEBAPP_BASE_URL}/api/webhook/trigger`, {
    headers: { 'content-type': 'application/json', 'x-webhook-signature': 'not-a-signature' },
    data: JSON.stringify({}),
  });

  expect(response.status()).toBe(404);
});
