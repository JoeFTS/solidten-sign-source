import fs from 'node:fs';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createTeam } from '@documenso/lib/server-only/team/create-team';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import type { User } from '@documenso/prisma/client';
import { type DocumentStatus, DocumentVisibility, RecipientRole, TeamMemberRole } from '@documenso/prisma/client';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import type {
  ZUsageReportDocumentsResponseSchema,
  ZUsageReportResponseSchema,
} from '@documenso/trpc/server/usage-report-router/schema';
import { expect, type Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { nanoid } from 'nanoid';
import type { z } from 'zod';

import { apiSignin } from '../fixtures/authentication';

const HOUR = 60 * 60 * 1000;

const daysAgo = (days: number) => DateTime.now().minus({ days }).toJSDate();

const AWKWARD_TITLE = 'Lease, "Unit 4"\nŁódź – 契約 😀';
const FORMULA_TITLE = '=HYPERLINK("http://evil.example","click")';

test.describe.configure({ mode: 'parallel' });

const seedReportDocument = async ({
  owner,
  teamId,
  status,
  sentAt,
  hoursToComplete,
  title,
  visibility = DocumentVisibility.EVERYONE,
  deletedAt,
  hasExpiredRecipient = false,
}: {
  owner: User;
  teamId: number;
  status: DocumentStatus;
  sentAt: Date;
  hoursToComplete?: number;
  title?: string;
  visibility?: DocumentVisibility;
  deletedAt?: Date;
  hasExpiredRecipient?: boolean;
}) => {
  const envelope = await seedBlankDocument(owner, teamId, {
    internalVersion: 2,
    createDocumentOptions: {
      status,
      visibility,
      deletedAt,
      ...(title ? { title } : {}),
      ...(hoursToComplete !== undefined ? { completedAt: new Date(sentAt.getTime() + hoursToComplete * HOUR) } : {}),
    },
  });

  await prisma.documentAuditLog.create({
    data: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT, createdAt: sentAt, data: {} },
  });

  if (hasExpiredRecipient) {
    await prisma.recipient.create({
      data: {
        envelopeId: envelope.id,
        email: `expired-${nanoid(6)}@test.documenso.com`,
        name: 'Expired',
        token: nanoid(),
        role: RecipientRole.SIGNER,
        expiresAt: daysAgo(1),
      },
    });
  }

  return envelope;
};

type TReport = z.infer<typeof ZUsageReportResponseSchema>;
type TDocuments = z.infer<typeof ZUsageReportDocumentsResponseSchema>;

const requestReport = async (page: Page, procedure: string, input: Record<string, unknown>) => {
  const encoded = encodeURIComponent(JSON.stringify({ json: { timezone: 'UTC', range: '30d', ...input } }));

  return await page
    .context()
    .request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/usageReport.${procedure}?input=${encoded}`);
};

const readJson = async <T>(response: Awaited<ReturnType<typeof requestReport>>): Promise<T> => {
  expect(response.status()).toBe(200);

  return ((await response.json()) as { result: { data: { json: T } } }).result.data.json;
};

const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const body = text.replace(/^﻿/, '');

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (inQuotes) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += char;
    }
  }

  return rows;
};

const downloadCsv = async (page: Page, testId: string, timeout = 15_000) => {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout }), page.getByTestId(testId).click()]);

  return parseCsv(fs.readFileSync((await download.path()) ?? '', 'utf8'));
};

test('[USAGE_REPORT]: team report shows outcomes, timing and per-member rows, and exports both CSVs', async ({
  page,
}) => {
  const { team, owner } = await seedTeam();
  const idleMember = await seedTeamMember({ teamId: team.id, name: 'Idle Member', role: TeamMemberRole.MEMBER });

  // Completed after 2, 6 and 10 hours: average and median are both 6 hours.
  await seedReportDocument({ owner, teamId: team.id, status: 'COMPLETED', sentAt: daysAgo(3), hoursToComplete: 2 });
  await seedReportDocument({ owner, teamId: team.id, status: 'COMPLETED', sentAt: daysAgo(4), hoursToComplete: 6 });
  await seedReportDocument({
    owner,
    teamId: team.id,
    status: 'COMPLETED',
    sentAt: daysAgo(5),
    hoursToComplete: 10,
    title: AWKWARD_TITLE,
  });
  await seedReportDocument({ owner, teamId: team.id, status: 'REJECTED', sentAt: daysAgo(6), title: FORMULA_TITLE });
  await seedReportDocument({ owner, teamId: team.id, status: 'CANCELLED', sentAt: daysAgo(7) });
  await seedReportDocument({
    owner,
    teamId: team.id,
    status: 'PENDING',
    sentAt: daysAgo(8),
    hasExpiredRecipient: true,
  });
  await seedReportDocument({ owner, teamId: team.id, status: 'PENDING', sentAt: daysAgo(9) });

  // Excluded: soft-deleted, and sent before the window.
  await seedReportDocument({
    owner,
    teamId: team.id,
    status: 'COMPLETED',
    sentAt: daysAgo(2),
    hoursToComplete: 500,
    deletedAt: new Date(),
    title: 'Deleted one',
  });
  await seedReportDocument({ owner, teamId: team.id, status: 'COMPLETED', sentAt: daysAgo(45), hoursToComplete: 1 });

  await apiSignin({ page, email: owner.email, redirectPath: `/t/${team.url}/analytics` });

  const card = page.getByTestId('analytics-usage-report');

  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('usage-report-declined')).toHaveText('1');
  await expect(card.getByTestId('usage-report-expired')).toHaveText('1');
  await expect(card.getByTestId('usage-report-cancelled')).toHaveText('1');
  await expect(card.getByTestId('usage-report-average')).toHaveText('6 h');
  await expect(card.getByTestId('usage-report-median')).toHaveText('6 h');
  await expect(card.getByTestId('usage-report-member-row')).toHaveCount(2);

  const report = await readJson<TReport>(await requestReport(page, 'getTeam', { teamId: team.id }));

  expect(report.summary).toMatchObject({
    sent: 7,
    completed: 3,
    declined: 1,
    cancelled: 1,
    expired: 1,
    pending: 1,
    timeToComplete: { count: 3, averageMs: 6 * HOUR, medianMs: 6 * HOUR },
  });

  const idle = report.members.find((member) => member.userId === idleMember.id);

  expect(idle).toMatchObject({ sent: 0, completed: 0, timeToComplete: { averageMs: null, medianMs: null } });

  const members = await downloadCsv(page, 'usage-report-download-members');

  expect(members[0][0]).toBe('Name');
  expect(members).toHaveLength(3);
  expect(members.find((row) => row[1] === owner.email)?.slice(2, 8)).toEqual(['7', '3', '1', '1', '1', '1']);
  expect(members.find((row) => row[1] === idleMember.email)?.[2]).toBe('0');

  const documents = await downloadCsv(page, 'usage-report-download-documents');
  const titleColumn = documents[0].indexOf('Title');
  const titles = documents.slice(1).map((row) => row[titleColumn]);

  expect(documents).toHaveLength(8);
  expect(titles).toContain(AWKWARD_TITLE);
  expect(titles).toContain(`'${FORMULA_TITLE}`);
  expect(titles).not.toContain('Deleted one');
  expect(documents[0]).not.toContain('Team');
});

test('[USAGE_REPORT]: roles without analytics access get 403 and visibility rules hold', async ({ page }) => {
  const { team, owner, organisation } = await seedTeam();
  const member = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MEMBER });
  const manager = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MANAGER });

  await seedReportDocument({ owner, teamId: team.id, status: 'COMPLETED', sentAt: daysAgo(2), hoursToComplete: 1 });
  await seedReportDocument({
    owner,
    teamId: team.id,
    status: 'COMPLETED',
    sentAt: daysAgo(2),
    hoursToComplete: 1,
    visibility: DocumentVisibility.ADMIN,
    title: 'Admins only',
  });

  await apiSignin({ page, email: member.email });

  for (const procedure of ['getTeam', 'getTeamDocuments']) {
    expect((await requestReport(page, procedure, { teamId: team.id })).status()).toBe(403);
  }

  for (const procedure of ['getOrganisation', 'getOrganisationDocuments']) {
    expect((await requestReport(page, procedure, { organisationId: organisation.id })).status()).toBe(403);
  }

  await page.context().clearCookies();
  await apiSignin({ page, email: manager.email });

  const managerView = await readJson<TDocuments>(await requestReport(page, 'getTeamDocuments', { teamId: team.id }));

  expect(managerView.documents.map((d) => d.title)).not.toContain('Admins only');
  expect(managerView.documents).toHaveLength(1);

  await page.context().clearCookies();
  await apiSignin({ page, email: owner.email });

  const ownerView = await readJson<TDocuments>(await requestReport(page, 'getTeamDocuments', { teamId: team.id }));

  expect(ownerView.documents).toHaveLength(2);
});

test('[USAGE_REPORT]: an empty range returns zeros and no timing', async ({ page }) => {
  const { team, owner, organisation } = await seedTeam();

  await apiSignin({ page, email: owner.email });

  const report = await readJson<TReport>(await requestReport(page, 'getTeam', { teamId: team.id, range: '7d' }));

  expect(report.summary).toEqual({
    sent: 0,
    completed: 0,
    declined: 0,
    cancelled: 0,
    expired: 0,
    pending: 0,
    completionRate: null,
    timeToComplete: { count: 0, averageMs: null, medianMs: null },
  });
  expect(report.members).toHaveLength(1);

  const orgDocuments = await readJson<TDocuments>(
    await requestReport(page, 'getOrganisationDocuments', { organisationId: organisation.id }),
  );

  expect(orgDocuments.documents).toEqual([]);
});

test('[USAGE_REPORT]: organisation report covers every team and the CSV names the team', async ({ page }) => {
  const { team, owner, organisation } = await seedTeam();

  const secondTeamUrl = `second-${nanoid(8).toLowerCase()}`;

  await createTeam({
    userId: owner.id,
    teamName: 'Second team',
    teamUrl: secondTeamUrl,
    organisationId: organisation.id,
    inheritMembers: true,
  });

  const secondTeam = await prisma.team.findUniqueOrThrow({ where: { url: secondTeamUrl } });

  await seedReportDocument({ owner, teamId: team.id, status: 'COMPLETED', sentAt: daysAgo(2), hoursToComplete: 4 });
  await seedReportDocument({ owner, teamId: secondTeam.id, status: 'REJECTED', sentAt: daysAgo(3) });

  await apiSignin({ page, email: owner.email, redirectPath: `/o/${organisation.url}/analytics` });

  const card = page.getByTestId('analytics-usage-report');

  await expect(card.getByTestId('usage-report-declined')).toHaveText('1', { timeout: 30_000 });

  const documents = await downloadCsv(page, 'usage-report-download-documents');
  const teamColumn = documents[0].indexOf('Team');

  expect(teamColumn).toBeGreaterThan(-1);
  expect(
    documents
      .slice(1)
      .map((row) => row[teamColumn])
      .sort(),
  ).toEqual([team.name, 'Second team'].sort());
});

test('[USAGE_REPORT]: 10,000 documents export in one CSV', async ({ page }) => {
  test.setTimeout(180_000);

  const { team, owner } = await seedTeam();
  const prefix = nanoid(8).toLowerCase();
  const base = 900_000_000 + Math.floor(Math.random() * 50_000_000);

  // Bulk insert straight into the tables; 10,000 seed calls would take minutes.
  await prisma.$executeRawUnsafe(`
    WITH rows AS (SELECT g AS n FROM generate_series(1, 10000) AS g),
    meta AS (
      INSERT INTO "DocumentMeta" ("id") SELECT 'dm_${prefix}_' || n FROM rows RETURNING "id"
    ),
    envelopes AS (
      INSERT INTO "Envelope" ("id", "secondaryId", "type", "title", "status", "source", "signatureLevel",
        "internalVersion", "userId", "teamId", "documentMetaId", "updatedAt", "completedAt")
      SELECT 'envelope_${prefix}_' || n, 'document_' || (${base} + n), 'DOCUMENT',
        'Bulk, "doc" #' || n, 'COMPLETED', 'DOCUMENT', 'SES', 2, ${owner.id}, ${team.id}, 'dm_${prefix}_' || n,
        now(), now() - interval '1 day' + (n || ' seconds')::interval
      FROM rows
      RETURNING "id"
    )
    INSERT INTO "DocumentAuditLog" ("id", "envelopeId", "type", "data", "createdAt")
    SELECT 'log_${prefix}_' || replace("id", 'envelope_${prefix}_', ''), "id", 'DOCUMENT_SENT', '{}'::jsonb,
      now() - interval '2 days'
    FROM envelopes
  `);

  await apiSignin({ page, email: owner.email, redirectPath: `/t/${team.url}/analytics` });

  const started = Date.now();
  const documents = await downloadCsv(page, 'usage-report-download-documents', 90_000);

  expect(documents).toHaveLength(10_001);
  expect(Date.now() - started).toBeLessThan(60_000);

  const titleColumn = documents[0].indexOf('Title');

  expect(documents.slice(1).every((row) => row[titleColumn].startsWith('Bulk, "doc" #'))).toBe(true);
  const median = page.getByTestId('analytics-usage-report').getByTestId('usage-report-median');

  await expect(median).toBeVisible({ timeout: 60_000 });
  await expect(median).not.toHaveText('-');
});
