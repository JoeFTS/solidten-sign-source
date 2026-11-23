import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { handleJobFinalFailure } from '@documenso/lib/jobs/client/job-final-failure';
import { countStuckUnsealed } from '@documenso/lib/server-only/jobs/stuck-unsealed';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { DocumentStatus } from '@documenso/prisma/client';
import { seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

/**
 * Solid Ten Sign (S-2): a seal that failed for good is recorded once and the owner and the
 * operators are told once; /api/health counts the documents nothing retries any more.
 */

test.describe.configure({ mode: 'serial' });

const HOUR = 60 * 60 * 1000;
const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const uniqueEmail = (label: string) =>
  `seal-failed-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

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

/** A document every signer finished, still PENDING because the seal did not run through. */
const seedUnsealed = async ({
  signedAt = new Date(),
  status = DocumentStatus.PENDING,
}: {
  signedAt?: Date;
  status?: DocumentStatus;
} = {}) => {
  const { user, team } = await seedUser();
  const signerEmail = uniqueEmail('signer');

  // A title of its own, so the mails of this test are told apart in the shared mail sink.
  const title = `[TEST] Seal failed ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const document = await seedCompletedDocument(user, team.id, [signerEmail], {
    internalVersion: 2,
    createDocumentOptions: { title, status, completedAt: status === DocumentStatus.COMPLETED ? new Date() : null },
  });

  await prisma.recipient.updateMany({ where: { envelopeId: document.id }, data: { signedAt } });

  return { user, team, title, document, signerEmail, documentId: mapSecondaryIdToDocumentId(document.secondaryId) };
};

/** A seal job that used its last attempt, as the job endpoint leaves it. */
const failSeal = async (documentId: number) => {
  const job = await prisma.backgroundJob.create({
    data: {
      jobId: 'internal.seal-document',
      name: 'Seal Document',
      version: '1.0.0',
      payload: { documentId, isResealing: true },
      status: 'FAILED',
      retried: 4,
      maxRetries: 4,
      completedAt: new Date(),
    },
  });

  await handleJobFinalFailure({ id: job.id, jobId: job.jobId, payload: job.payload, retried: job.retried });
};

const sealFailedNotices = async (envelopeId: string) =>
  await prisma.backgroundJob.findMany({
    where: {
      jobId: 'send.solidten.notice.email',
      AND: [
        { payload: { path: ['kind'], equals: 'SEAL_FAILED' } },
        { payload: { path: ['envelopeId'], equals: envelopeId } },
      ],
    },
  });

const mailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

test('S-2: three seal give-ups write one audit entry and send one notice, to the owner and not the signer', async () => {
  const { user, document, signerEmail, documentId } = await seedUnsealed();

  // The first failure, then two more from the seal sweep's reseals.
  await failSeal(documentId);
  await failSeal(documentId);
  await failSeal(documentId);

  const entries = await prisma.documentAuditLog.findMany({
    where: { envelopeId: document.id, type: 'DOCUMENT_SEAL_FAILED' },
  });
  expect(entries).toHaveLength(1);
  expect(entries[0].data).toMatchObject({ attempts: 5, isRejected: false });

  const notices = await sealFailedNotices(document.id);
  expect(notices).toHaveLength(1);
  expect(notices[0].payload).toMatchObject({ kind: 'SEAL_FAILED', isRejected: false });

  expect(await waitFor(async () => (await sealFailedNotices(document.id))[0]?.status === 'COMPLETED')).toBe(true);

  if (MAIL_SINK_URL) {
    expect(
      await waitFor(async () =>
        (await mailSubjects(user.email)).some((subject) => subject.includes('the final PDF could not be made')),
      ),
    ).toBe(true);
    expect(
      (await mailSubjects(user.email)).filter((subject) => subject.includes('the final PDF could not be made')),
    ).toHaveLength(1);
    expect(await mailSubjects(signerEmail)).toEqual([]);
  }

  expect(await prisma.envelope.findUniqueOrThrow({ where: { id: document.id } })).toMatchObject({
    status: DocumentStatus.PENDING,
  });
});

test('S-2: a failed reseal of a finished document records and sends nothing', async () => {
  const { document, documentId } = await seedUnsealed({ status: DocumentStatus.COMPLETED });

  await failSeal(documentId);

  expect(
    await prisma.documentAuditLog.count({ where: { envelopeId: document.id, type: 'DOCUMENT_SEAL_FAILED' } }),
  ).toBe(0);
  expect(await sealFailedNotices(document.id)).toHaveLength(0);
});

test('S-2: /api/health counts the documents nothing retries any more (stuckUnsealed)', async ({ request }) => {
  const before = await countStuckUnsealed();

  // Stuck: last signature 7 hours ago, seal FAILED.
  const stuck = await seedUnsealed({ signedAt: new Date(Date.now() - 7 * HOUR) });
  await failSeal(stuck.documentId);

  // Not stuck: still inside the 6-hour window (the seal sweep retries it).
  const recent = await seedUnsealed({ signedAt: new Date(Date.now() - 1 * HOUR) });
  await failSeal(recent.documentId);

  // Not stuck: old, but no failed seal job.
  await seedUnsealed({ signedAt: new Date(Date.now() - 7 * HOUR) });

  expect(await countStuckUnsealed()).toBe(before + 1);

  // A reseal that worked: no longer counted.
  await prisma.envelope.update({ where: { id: stuck.document.id }, data: { status: DocumentStatus.COMPLETED } });
  expect(await countStuckUnsealed()).toBe(before);
  await prisma.envelope.update({ where: { id: stuck.document.id }, data: { status: DocumentStatus.PENDING } });

  // The token-protected detail (a direct local call here, or the token when one is set).
  const token = process.env.NEXT_PRIVATE_ST_HEALTH_TOKEN?.trim();
  const res = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/health`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    timeout: 30_000,
  });
  const body = (await res.json()) as { jobs?: { stuckUnsealed?: number } };

  expect(body.jobs?.stuckUnsealed).toBe(await countStuckUnsealed());
  expect(body.jobs?.stuckUnsealed).toBeGreaterThanOrEqual(1);

  // The public answer has no detail.
  const outside = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/health`, {
    headers: { 'x-forwarded-for': '203.0.113.5' },
    timeout: 30_000,
  });
  expect(((await outside.json()) as { jobs?: unknown }).jobs).toBeUndefined();
});

/* -------------------------------------------------------------------------- */
/*   S-2 follow-up: the operators' copy is a server-health notice             */
/* -------------------------------------------------------------------------- */

// The app server and this test both need NEXT_PRIVATE_ST_OPERATOR_EMAILS set to two addresses.
const OPERATORS = (process.env.NEXT_PRIVATE_ST_OPERATOR_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const subjectsWith = async (to: string, title: string) =>
  (await mailSubjects(to)).filter((subject) => subject.includes(title));

test.describe('S-2 follow-up: operators listed in NEXT_PRIVATE_ST_OPERATOR_EMAILS', () => {
  test.skip(
    OPERATORS.length < 2 || !MAIL_SINK_URL,
    'needs NEXT_PRIVATE_ST_OPERATOR_EMAILS with two addresses on the app and the tests, and E2E_MAIL_SINK_URL',
  );

  test('each operator gets one copy, the owner one, the signer none', async () => {
    const { user, title, signerEmail, documentId } = await seedUnsealed();

    await failSeal(documentId);
    await failSeal(documentId);

    for (const operator of OPERATORS) {
      expect(await waitFor(async () => (await subjectsWith(operator, title)).length > 0)).toBe(true);
    }
    expect(await waitFor(async () => (await subjectsWith(user.email, title)).length > 0)).toBe(true);

    for (const operator of OPERATORS) {
      expect(await subjectsWith(operator, title)).toHaveLength(1);
    }
    expect(await subjectsWith(user.email, title)).toHaveLength(1);
    expect(await mailSubjects(signerEmail)).toEqual([]);
  });

  test('with the organisation email turned off: the operators are still told, the owner is not', async () => {
    const { user, team, title, document, signerEmail, documentId } = await seedUnsealed();

    const { organisation } = await prisma.team.findUniqueOrThrow({
      where: { id: team.id },
      select: { organisation: { select: { organisationClaim: true } } },
    });
    const claim = organisation.organisationClaim;

    await prisma.organisationClaim.update({
      where: { id: claim.id },
      data: { flags: { ...(claim.flags as Record<string, unknown>), disableEmails: true } },
    });

    await failSeal(documentId);

    expect(await waitFor(async () => (await sealFailedNotices(document.id))[0]?.status === 'COMPLETED')).toBe(true);

    for (const operator of OPERATORS) {
      expect(await waitFor(async () => (await subjectsWith(operator, title)).length > 0)).toBe(true);
      expect(await subjectsWith(operator, title)).toHaveLength(1);
    }

    expect(await subjectsWith(user.email, title)).toEqual([]);
    expect(await mailSubjects(signerEmail)).toEqual([]);
  });
});
