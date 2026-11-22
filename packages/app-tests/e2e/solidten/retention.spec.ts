import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { applyRetentionToEnvelope } from '@documenso/lib/server-only/retention/apply-retention';
import { processRetentionBatch } from '@documenso/lib/server-only/retention/process-retention-batch';
import { findRetentionCandidates } from '@documenso/lib/server-only/retention/run-retention-sweep';
import type { TRetentionSettings } from '@documenso/lib/utils/retention';
import { prisma } from '@documenso/prisma';
import { DocumentDataType, DocumentStatus, EnvelopeType, Prisma } from '@documenso/prisma/client';
import { seedCompletedDocument, seedDraftDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { expectToastTextToBeVisible } from '../fixtures/generic';

test.describe.configure({ mode: 'parallel' });

const DAY = 24 * 60 * 60 * 1000;

const rule = (overrides: Partial<TRetentionSettings> = {}): TRetentionSettings => ({
  enabled: true,
  action: 'PURGE',
  days: 30,
  includeRejected: false,
  includeCancelled: false,
  ...overrides,
});

/**
 * Store a team rule as if an admin had saved it long enough ago for a purge to run
 * (the purge grace period counts from the last recorded change).
 */
const setTeamRule = async (teamId: number, settings: TRetentionSettings) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });

  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { retentionSettings: settings },
  });

  await prisma.stSettingsAuditLog.create({
    data: {
      organisationId: team.organisationId,
      teamId,
      setting: 'retentionSettings',
      newValue: settings,
      userEmail: 'seed@test.documenso.com',
      createdAt: new Date(Date.now() - 8 * DAY),
    },
  });
};

const trpcRequest = async (
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  json: Record<string, unknown>,
  teamId: number,
) => {
  const headers = { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(teamId) };

  if (method === 'GET') {
    return await page
      .context()
      .request.get(
        `${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json }))}`,
        { headers },
      );
  }

  return await page.context().request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}`, {
    headers: { ...headers, 'content-type': 'application/json' },
    data: JSON.stringify({ json }),
  });
};

const uniqueValue = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * A finished document whose stored data is unique to it, so tests running in
 * parallel never share stored values by accident.
 */
const seedFinished = async ({
  user,
  teamId,
  completedAt,
  status = DocumentStatus.COMPLETED,
  storage = DocumentDataType.BYTES_64,
}: {
  user: Awaited<ReturnType<typeof seedUser>>['user'];
  teamId: number;
  completedAt: Date;
  status?: DocumentStatus;
  storage?: DocumentDataType;
}) => {
  const document = await seedCompletedDocument(user, teamId, [`${uniqueValue('signer')}@test.documenso.com`], {
    internalVersion: 2,
    createDocumentOptions: { status, completedAt },
  });

  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });

  const value = uniqueValue('stored');

  await prisma.documentData.update({
    where: { id: item.documentDataId },
    data: { type: storage, data: value, initialData: value },
  });

  await prisma.documentAuditLog.create({
    data: { envelopeId: document.id, type: 'DOCUMENT_COMPLETED', data: { transactionId: 'seed' } },
  });

  return {
    envelopeId: document.id,
    documentDataId: item.documentDataId,
    documentMetaId: document.documentMetaId,
    value,
  };
};

/**
 * What sealing (or rendering contents) does to stored data: a new copy, and the
 * envelope item moved to it. Returns the earlier copy, which nothing points at now.
 */
const simulateSealing = async (envelopeId: string, sealedValue = uniqueValue('sealed')) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  const sealed = await prisma.documentData.create({
    data: { type: DocumentDataType.BYTES_64, data: sealedValue, initialData: sealedValue },
  });

  await prisma.envelopeItem.update({ where: { id: item.id }, data: { documentDataId: sealed.id } });

  return { id: item.documentDataId, sealedId: sealed.id };
};

test('[RETENTION]: picks exactly the finished documents past the rule, including the boundary', async () => {
  const { user, team } = await seedUser();
  const now = new Date();

  await setTeamRule(team.id, rule({ action: 'SOFT_DELETE', includeRejected: true }));

  const old = await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 31 * DAY) });
  const boundary = await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 30 * DAY) });
  const young = await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 30 * DAY + 60_000) });
  const rejected = await seedFinished({
    user,
    teamId: team.id,
    completedAt: new Date(now.getTime() - 40 * DAY),
    status: DocumentStatus.REJECTED,
  });
  const cancelled = await seedFinished({
    user,
    teamId: team.id,
    completedAt: new Date(now.getTime() - 40 * DAY),
    status: DocumentStatus.CANCELLED,
  });

  const draft = await seedDraftDocument(user, team.id, ['draft@test.documenso.com'], {
    internalVersion: 2,
    createDocumentOptions: { createdAt: new Date(now.getTime() - 400 * DAY) },
  });
  const pending = await seedPendingDocument(user, team.id, ['pending@test.documenso.com'], {
    internalVersion: 2,
    createDocumentOptions: { createdAt: new Date(now.getTime() - 400 * DAY) },
  });
  const template = await seedBlankTemplate(user, team.id);
  await prisma.envelope.update({
    where: { id: template.id },
    data: { status: DocumentStatus.COMPLETED, completedAt: new Date(now.getTime() - 400 * DAY) },
  });

  const candidates = await findRetentionCandidates({ now, teamIds: [team.id] });
  const ids = candidates.map((candidate) => candidate.envelopeId).sort();

  expect(ids).toEqual([old.envelopeId, boundary.envelopeId, rejected.envelopeId].sort());

  for (const id of [old.envelopeId, boundary.envelopeId, young.envelopeId, cancelled.envelopeId]) {
    await applyRetentionToEnvelope({ envelopeId: id, now, dryRun: false });
  }

  // Even when asked directly, drafts, pending documents and templates are left alone.
  for (const id of [draft.id, pending.id, template.id]) {
    expect((await applyRetentionToEnvelope({ envelopeId: id, now, dryRun: false })).result).toBe('SKIPPED');
  }

  const after = await prisma.envelope.findMany({
    where: { teamId: team.id },
    select: { id: true, deletedAt: true, type: true },
  });

  const deletedIds = after
    .filter((envelope) => envelope.deletedAt)
    .map((envelope) => envelope.id)
    .sort();

  expect(deletedIds).toEqual([old.envelopeId, boundary.envelopeId].sort());
  expect(after).toHaveLength(8);

  const audit = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: old.envelopeId, type: 'DOCUMENT_RETENTION_APPLIED' },
  });
  expect(audit.data).toMatchObject({ action: 'SOFT_DELETE', days: 30 });
});

test('[RETENTION]: purge with database storage removes the files and the rows hard deletes leave behind', async () => {
  const { user, team } = await seedUser();
  const now = new Date();

  await setTeamRule(team.id, rule());

  const target = await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 90 * DAY) });

  // Sealing writes a new copy and points the item at it; the unsigned copy is left
  // with no item pointing at it.
  const leftover = await simulateSealing(target.envelopeId);

  const auditBefore = await prisma.documentAuditLog.findMany({
    where: { envelopeId: target.envelopeId },
    select: { id: true },
  });

  const webhook = await prisma.webhook.create({
    data: {
      webhookUrl: 'https://example.com/solidten-purge-hook',
      eventTriggers: ['DOCUMENT_PURGED'],
      userId: user.id,
      teamId: team.id,
    },
  });

  const outcome = await applyRetentionToEnvelope({ envelopeId: target.envelopeId, now, dryRun: false });

  expect(outcome).toEqual({ result: 'PURGED', objectKeysToDelete: [] });

  expect(await prisma.envelope.findUnique({ where: { id: target.envelopeId } })).toBeNull();
  expect(await prisma.documentData.count({ where: { id: { in: [leftover.id, leftover.sealedId] } } })).toBe(0);
  expect(await prisma.documentMeta.findUnique({ where: { id: target.documentMetaId } })).toBeNull();
  expect(await prisma.recipient.count({ where: { envelopeId: target.envelopeId } })).toBe(0);

  // Solid Ten Sign (G2): the audit rows go with the document; one minimal record stays.
  const survivingAudit = await prisma.documentAuditLog.findMany({
    where: { id: { in: auditBefore.map((log) => log.id) } },
  });
  expect(survivingAudit).toHaveLength(0);

  const finalEntry = await prisma.documentAuditLog.findFirstOrThrow({
    where: { type: 'DOCUMENT_RETENTION_APPLIED', data: { path: ['envelopeId'], equals: target.envelopeId } },
  });
  expect(finalEntry.envelopeId).toBeNull();
  expect(finalEntry.userAgent).toBe('Solid Ten Sign retention');
  expect(finalEntry.data).toMatchObject({
    auditLogIds: [],
    erasedAuditLogCount: auditBefore.length,
    recipientCount: 1,
  });

  await expect
    .poll(async () =>
      prisma.backgroundJob.count({
        where: {
          jobId: 'internal.execute-webhook',
          AND: [
            { payload: { path: ['webhookId'], equals: webhook.id } },
            { payload: { path: ['event'], equals: 'DOCUMENT_PURGED' } },
          ],
        },
      }),
    )
    .toBe(1);
});

test('[RETENTION]: purge keeps stored objects that a template still uses (object storage)', async () => {
  const { user, team } = await seedUser();
  const now = new Date();

  await setTeamRule(team.id, rule());

  const templateKey = `${uniqueValue('template')}/original.pdf`;
  const sealedKey = `${uniqueValue('document')}/sealed.pdf`;
  const uploadKey = `${uniqueValue('document')}/upload.pdf`;

  const template = await seedBlankTemplate(user, team.id);
  const templateItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

  await prisma.documentData.update({
    where: { id: templateItem.documentDataId },
    data: { type: DocumentDataType.S3_PATH, data: templateKey, initialData: templateKey },
  });

  // A document made from the template: its signed file is its own, its original is the template's.
  const fromTemplate = await seedFinished({
    user,
    teamId: team.id,
    completedAt: new Date(now.getTime() - 90 * DAY),
    storage: DocumentDataType.S3_PATH,
  });

  await prisma.documentData.update({
    where: { id: fromTemplate.documentDataId },
    data: { data: sealedKey, initialData: templateKey },
  });

  const ownUpload = await seedFinished({
    user,
    teamId: team.id,
    completedAt: new Date(now.getTime() - 90 * DAY),
    storage: DocumentDataType.S3_PATH,
  });

  await prisma.documentData.update({
    where: { id: ownUpload.documentDataId },
    data: { data: uploadKey, initialData: uploadKey },
  });

  const fromTemplateOutcome = await applyRetentionToEnvelope({
    envelopeId: fromTemplate.envelopeId,
    now,
    dryRun: false,
  });
  expect(fromTemplateOutcome).toEqual({ result: 'PURGED', objectKeysToDelete: [sealedKey] });

  const ownOutcome = await applyRetentionToEnvelope({ envelopeId: ownUpload.envelopeId, now, dryRun: false });
  expect(ownOutcome).toEqual({ result: 'PURGED', objectKeysToDelete: [uploadKey] });

  const templateData = await prisma.documentData.findUniqueOrThrow({ where: { id: templateItem.documentDataId } });
  expect(templateData.data).toBe(templateKey);
  expect(await prisma.envelope.findUnique({ where: { id: template.id } })).not.toBeNull();
});

test('[RETENTION]: dry run changes nothing, by argument and by environment variable', async () => {
  const { user, team } = await seedUser();
  const now = new Date();

  await setTeamRule(team.id, rule());

  const target = await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 90 * DAY) });

  expect(await applyRetentionToEnvelope({ envelopeId: target.envelopeId, now, dryRun: true })).toEqual({
    result: 'DRY_RUN',
    action: 'PURGE',
  });

  const previous = process.env.NEXT_PRIVATE_RETENTION_DRY_RUN;
  process.env.NEXT_PRIVATE_RETENTION_DRY_RUN = 'true';

  try {
    expect((await applyRetentionToEnvelope({ envelopeId: target.envelopeId, now })).result).toBe('DRY_RUN');
  } finally {
    process.env.NEXT_PRIVATE_RETENTION_DRY_RUN = previous;
  }

  expect(await prisma.envelope.findUnique({ where: { id: target.envelopeId } })).not.toBeNull();
  expect(await prisma.documentData.findUnique({ where: { id: target.documentDataId } })).not.toBeNull();
  expect(
    await prisma.documentAuditLog.count({
      where: { type: 'DOCUMENT_RETENTION_APPLIED', envelopeId: target.envelopeId },
    }),
  ).toBe(0);
});

test('[RETENTION]: a rule changed or turned off while the sweep runs is respected', async () => {
  const { user, team, organisation } = await seedUser();
  const now = new Date();

  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { retentionSettings: rule() },
  });

  const first = await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 90 * DAY) });
  const second = await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 90 * DAY) });

  const candidates = await findRetentionCandidates({ now, teamIds: [team.id] });
  expect(candidates.map((candidate) => candidate.envelopeId).sort()).toEqual(
    [first.envelopeId, second.envelopeId].sort(),
  );

  // The team switches to a softer rule after the sweep queued the purge.
  await setTeamRule(team.id, rule({ action: 'SOFT_DELETE' }));
  expect((await applyRetentionToEnvelope({ envelopeId: first.envelopeId, now, dryRun: false })).result).toBe(
    'SOFT_DELETED',
  );

  // Then turns retention off for the team.
  await setTeamRule(team.id, rule({ enabled: false }));
  expect((await applyRetentionToEnvelope({ envelopeId: second.envelopeId, now, dryRun: false })).result).toBe(
    'SKIPPED',
  );

  expect(await prisma.envelope.count({ where: { id: { in: [first.envelopeId, second.envelopeId] } } })).toBe(2);
  expect(await findRetentionCandidates({ now, teamIds: [team.id] })).toHaveLength(0);
});

test('[RETENTION]: the settings page shows how many documents a rule affects before it is saved', async ({ page }) => {
  const { user, team } = await seedUser();
  const now = new Date();

  await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 100 * DAY) });
  await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 50 * DAY) });
  await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 5 * DAY) });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/lifecycle` });

  await page.getByTestId('retention-enabled-select').click();
  await page.getByRole('option', { name: 'On', exact: true }).click();

  await page.getByTestId('retention-days-input').fill('30');
  await expect(page.getByTestId('retention-preview')).toContainText('would affect 2 documents right now');

  await page.getByTestId('retention-days-input').fill('60');
  await expect(page.getByTestId('retention-preview')).toContainText('would affect 1 document right now');

  // Nothing is stored until the user saves.
  const before = await prisma.teamGlobalSettings.findFirstOrThrow({ where: { team: { id: team.id } } });
  expect(before.retentionSettings).toBeNull();

  await page.getByTestId('retention-settings').getByRole('button', { name: /Save/ }).click();
  await expectToastTextToBeVisible(page, 'Retention settings updated');

  const after = await prisma.teamGlobalSettings.findFirstOrThrow({ where: { team: { id: team.id } } });
  expect(after.retentionSettings).toMatchObject({ enabled: true, action: 'SOFT_DELETE', days: 60 });

  // Saving the rule deletes nothing by itself; the daily sweep does that.
  expect(
    await prisma.envelope.count({ where: { teamId: team.id, type: EnvelopeType.DOCUMENT, deletedAt: null } }),
  ).toBe(3);
});

test('[RETENTION][S-M3]: purge rules need an admin, 30 days, a recorded change and a 7-day wait', async ({ page }) => {
  const { user: admin, team } = await seedUser();
  const manager = await seedTeamMember({ teamId: team.id, role: 'MANAGER' });
  const now = new Date();

  // A document only admins can see, finished long ago.
  const hidden = await seedFinished({ user: admin, teamId: team.id, completedAt: new Date(now.getTime() - 400 * DAY) });
  await prisma.envelope.update({ where: { id: hidden.envelopeId }, data: { visibility: 'ADMIN' } });

  const scope = { type: 'team', teamId: team.id };
  const purge = rule({ days: 30, includeRejected: true, includeCancelled: true });

  // The manager cannot see the document, so the preview must not count it.
  await apiSignin({ page, email: manager.email });

  const preview = await trpcRequest(page, 'GET', 'lifecycle.previewRetention', { scope, settings: purge }, team.id);
  expect(preview.ok(), await preview.text()).toBe(true);
  expect((await preview.json()).result.data.json.count).toBe(0);

  // And cannot set a purge rule.
  const byManager = await trpcRequest(
    page,
    'POST',
    'lifecycle.updateSettings',
    { scope, data: { retentionSettings: purge } },
    team.id,
  );
  expect(byManager.ok()).toBe(false);
  expect(await byManager.text()).toContain('Only a team or organisation admin');

  // A soft-delete rule is still a manager's choice, and it is recorded.
  const softByManager = await trpcRequest(
    page,
    'POST',
    'lifecycle.updateSettings',
    { scope, data: { retentionSettings: rule({ action: 'SOFT_DELETE', days: 400 }) } },
    team.id,
  );
  expect(softByManager.ok(), await softByManager.text()).toBe(true);

  await page.context().clearCookies();
  await apiSignin({ page, email: admin.email });

  // Below 30 days is refused, even for an admin.
  const tooShort = await trpcRequest(
    page,
    'POST',
    'lifecycle.updateSettings',
    { scope, data: { retentionSettings: rule({ days: 7 }) } },
    team.id,
  );
  expect(tooShort.ok()).toBe(false);
  expect(await tooShort.text()).toContain('at least 30 days');

  const byAdmin = await trpcRequest(
    page,
    'POST',
    'lifecycle.updateSettings',
    { scope, data: { retentionSettings: purge } },
    team.id,
  );
  expect(byAdmin.ok(), await byAdmin.text()).toBe(true);

  // Every change is recorded with the old value, the new value and who made it.
  const changes = await prisma.stSettingsAuditLog.findMany({
    where: { teamId: team.id, setting: 'retentionSettings' },
    orderBy: { createdAt: 'asc' },
  });

  expect(changes).toHaveLength(2);
  expect(changes[0]).toMatchObject({ userId: manager.id, oldValue: null });
  expect(changes[0].newValue).toMatchObject({ action: 'SOFT_DELETE', days: 400 });
  expect(changes[1]).toMatchObject({ userId: admin.id, userEmail: admin.email });
  expect(changes[1].oldValue).toMatchObject({ action: 'SOFT_DELETE', days: 400 });
  expect(changes[1].newValue).toMatchObject({ action: 'PURGE', days: 30 });

  // The new purge rule waits 7 days after the change.
  expect(await applyRetentionToEnvelope({ envelopeId: hidden.envelopeId, now, dryRun: false })).toEqual({
    result: 'SKIPPED',
    reason: 'Purge held back: GRACE_PERIOD',
  });
  expect(await prisma.envelope.findUnique({ where: { id: hidden.envelopeId } })).not.toBeNull();

  const later = new Date(now.getTime() + 8 * DAY);
  expect((await applyRetentionToEnvelope({ envelopeId: hidden.envelopeId, now: later, dryRun: false })).result).toBe(
    'PURGED',
  );
});

test('[RETENTION][SETTINGS-AUDIT]: a rule is never saved without its recorded change', async ({ page }) => {
  const { user: admin, team } = await seedUser();
  const scope = { type: 'team', teamId: team.id };

  // The audit insert fails for this team only (a database error between the two writes).
  const trigger = `st_fail_audit_${team.id}`;

  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger AS $$
    BEGIN
      IF NEW."teamId" = ${team.id} THEN RAISE EXCEPTION 'audit write failed (test)'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON "StSettingsAuditLog" FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );

  try {
    await apiSignin({ page, email: admin.email });

    const save = await trpcRequest(
      page,
      'POST',
      'lifecycle.updateSettings',
      { scope, data: { retentionSettings: rule({ days: 30 }) } },
      team.id,
    );
    expect(save.ok()).toBe(false);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "StSettingsAuditLog"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }

  // The rule did not change, so no purge can start without a recorded change and its wait.
  const settings = await prisma.teamGlobalSettings.findFirstOrThrow({ where: { team: { id: team.id } } });
  expect(settings.retentionSettings).toBeNull();
  expect(await prisma.stSettingsAuditLog.count({ where: { teamId: team.id } })).toBe(0);

  // Saved again with the database healthy: the rule and its record go in together.
  const retry = await trpcRequest(
    page,
    'POST',
    'lifecycle.updateSettings',
    { scope, data: { retentionSettings: rule({ days: 30 }) } },
    team.id,
  );
  expect(retry.ok(), await retry.text()).toBe(true);
  expect(await prisma.stSettingsAuditLog.count({ where: { teamId: team.id } })).toBe(1);
});

test('[RETENTION]: the organisation preview counts teams that store "inherit" as JSON null', async ({ page }) => {
  const { user, team, organisation } = await seedUser();
  const now = new Date();

  // Teams made on this build store "inherit" as JSON null, not SQL NULL.
  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { retentionSettings: Prisma.JsonNull },
  });

  await seedFinished({ user, teamId: team.id, completedAt: new Date(now.getTime() - 100 * DAY) });

  await apiSignin({ page, email: user.email });

  const preview = await trpcRequest(
    page,
    'GET',
    'lifecycle.previewRetention',
    { scope: { type: 'organisation', organisationId: organisation.id }, settings: rule({ action: 'SOFT_DELETE' }) },
    team.id,
  );
  expect(preview.ok(), await preview.text()).toBe(true);
  expect((await preview.json()).result.data.json.count).toBe(1);
});

/**
 * Finished documents that all hold the same PDF, as when one contract is sent to
 * many clients, each sealed (so each also has an earlier copy).
 */
const seedSharedPdfDocuments = async ({ count, pdf }: { count: number; pdf: string }) => {
  const { user, team } = await seedUser();
  const completedAt = new Date(Date.now() - 90 * DAY);

  const envelopeIds: string[] = [];
  const documentDataIds: string[] = [];

  for (let index = 0; index < count; index++) {
    const { envelopeId, documentDataId } = await seedFinished({ user, teamId: team.id, completedAt });

    await prisma.documentData.update({ where: { id: documentDataId }, data: { data: pdf, initialData: pdf } });

    const { sealedId } = await simulateSealing(envelopeId, pdf);

    envelopeIds.push(envelopeId);
    documentDataIds.push(documentDataId, sealedId);
  }

  return { team, envelopeIds, documentDataIds };
};

test('[RETENTION]: a purge deletes its own copies by id even when other documents hold the same bytes', async () => {
  const pdf = `${uniqueValue('shared-msa')}${'A'.repeat(50_000)}`;

  const purged = await seedSharedPdfDocuments({ count: 1, pdf });
  const kept = await seedSharedPdfDocuments({ count: 1, pdf });

  await setTeamRule(purged.team.id, rule());

  const outcome = await applyRetentionToEnvelope({ envelopeId: purged.envelopeIds[0], dryRun: false });
  expect(outcome).toEqual({ result: 'PURGED', objectKeysToDelete: [] });

  expect(await prisma.documentData.count({ where: { id: { in: purged.documentDataIds } } })).toBe(0);
  expect(await prisma.detachedDocumentData.count({ where: { envelopeId: purged.envelopeIds[0] } })).toBe(0);

  // The other document's rows, same bytes, are untouched.
  expect(await prisma.documentData.count({ where: { id: { in: kept.documentDataIds } } })).toBe(2);
});

test('[RETENTION]: purging 100 documents that share one PDF keeps memory flat and purges each once', async () => {
  test.setTimeout(300_000);

  const pdf = `${uniqueValue('shared-msa')}${'B'.repeat(400_000)}`;

  const { team, envelopeIds, documentDataIds } = await seedSharedPdfDocuments({ count: 100, pdf });

  await setTeamRule(team.id, rule());

  // JS heap: where loaded PDF strings would land; it is not shared with the query
  // engine or other tests the way the whole process RSS is, so it is the sharp
  // measure. RSS is checked too, more loosely.
  const before = process.memoryUsage();
  let heapPeak = before.heapUsed;
  let rssPeak = before.rss;

  const sampler = setInterval(() => {
    const now = process.memoryUsage();
    heapPeak = Math.max(heapPeak, now.heapUsed);
    rssPeak = Math.max(rssPeak, now.rss);
  }, 25);

  // Two sweeps at once, as a re-run or a second instance would: each document is purged once.
  const [first, second] = await Promise.all([
    processRetentionBatch({ teamIds: [team.id], limit: 100 }),
    processRetentionBatch({ teamIds: [team.id], limit: 100 }),
  ]).finally(() => clearInterval(sampler));

  const heapGrowthMb = (heapPeak - before.heapUsed) / (1024 * 1024);
  const rssGrowthMb = (rssPeak - before.rss) / (1024 * 1024);

  // A single purge of the old code read about 160 MB of strings here (199 rows x 2
  // copies x 400 KB). The peak includes garbage not yet collected from 100 purges.
  expect(heapGrowthMb).toBeLessThan(100);
  expect(rssGrowthMb).toBeLessThan(150);
  expect(first.failedCount + second.failedCount).toBe(0);
  expect(first.actedCount + second.actedCount).toBe(100);

  expect(await prisma.envelope.count({ where: { id: { in: envelopeIds } } })).toBe(0);
  expect(await prisma.documentData.count({ where: { id: { in: documentDataIds } } })).toBe(0);

  const finalEntries = await prisma.documentAuditLog.findMany({
    where: { type: 'DOCUMENT_RETENTION_APPLIED', data: { path: ['action'], equals: 'PURGE' } },
    select: { data: true },
  });

  const purgedIds = finalEntries
    .map((entry) => (entry.data as { envelopeId: string }).envelopeId)
    .filter((id) => envelopeIds.includes(id));

  expect(purgedIds).toHaveLength(100);
  expect(new Set(purgedIds).size).toBe(100);

  // Nothing is left for a later run.
  expect(await processRetentionBatch({ teamIds: [team.id], limit: 100 })).toMatchObject({
    candidateCount: 0,
    actedCount: 0,
  });
});

test('[RETENTION][RT2-M1]: going back to "inherit" a purge rule needs an admin and starts the wait', async ({
  page,
}) => {
  const { user: admin, team, organisation } = await seedUser();
  const manager = await seedTeamMember({ teamId: team.id, role: 'MANAGER' });
  const now = new Date();

  // The organisation purges after 30 days; the change is long past its wait.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { retentionSettings: rule({ days: 30 }) },
  });
  await prisma.stSettingsAuditLog.create({
    data: {
      organisationId: organisation.id,
      teamId: null,
      setting: 'retentionSettings',
      userEmail: 'seed@test.documenso.com',
      createdAt: new Date(now.getTime() - 30 * DAY),
    },
  });

  // The team's admin opted out.
  await setTeamRule(team.id, rule({ enabled: false, action: 'SOFT_DELETE' }));

  const old = await seedFinished({ user: admin, teamId: team.id, completedAt: new Date(now.getTime() - 100 * DAY) });
  const scope = { type: 'team', teamId: team.id };

  // A manager cannot hand the team back to the organisation's purge rule.
  await apiSignin({ page, email: manager.email });

  const byManager = await trpcRequest(
    page,
    'POST',
    'lifecycle.updateSettings',
    { scope, data: { retentionSettings: null } },
    team.id,
  );
  expect(byManager.ok()).toBe(false);
  expect(await byManager.text()).toContain('Only a team or organisation admin');

  // An admin can, and the purge then waits 7 days from this change.
  await page.context().clearCookies();
  await apiSignin({ page, email: admin.email });

  const byAdmin = await trpcRequest(
    page,
    'POST',
    'lifecycle.updateSettings',
    { scope, data: { retentionSettings: null } },
    team.id,
  );
  expect(byAdmin.ok(), await byAdmin.text()).toBe(true);

  expect(await applyRetentionToEnvelope({ envelopeId: old.envelopeId, now: new Date(), dryRun: false })).toEqual({
    result: 'SKIPPED',
    reason: 'Purge held back: GRACE_PERIOD',
  });
});
