import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten: heavy PDF work in a child process (LD3-H1, LD3-M1). Needs E2E_LARGE_PDF_PATH (a 14-15
 * MB PDF); skipped without it. The responsiveness and memory checks are meant for a built server
 * (`npm run build -w @documenso/remix`, then `npm run start`): the dev server's own work adds noise.
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const apiUrl = `${WEBAPP_BASE_URL}/api/v2-beta`;
const LARGE_PDF_PATH = process.env.E2E_LARGE_PDF_PATH;

const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@pdfchild.test`;

type Health = {
  memory?: { rssMb: number };
  pdfQueue?: { busy: boolean; waiting: number };
  pdfChild?: { runs: number; fallbacks: number; failures: number; lastStartupMs: number | null };
};

const getHealth = async (request: APIRequestContext) => {
  const started = Date.now();
  const res = await request.get(`${WEBAPP_BASE_URL}/api/health`, { timeout: 60_000 });
  const body = (await res.json()) as Health;

  return { body, ms: Date.now() - started };
};

const createOwner = async () => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'pdf-child', expiresIn: null });

  return { user, team, authHeaders: { Authorization: `Bearer ${token}` } };
};

type Owner = Awaited<ReturnType<typeof createOwner>>;

const createLarge = async (
  request: APIRequestContext,
  owner: Owner,
  pdf: Buffer,
  recipients: TCreateEnvelopePayload['recipients'] = [],
) => {
  const formData = new FormData();
  formData.append(
    'payload',
    JSON.stringify({
      type: EnvelopeType.DOCUMENT,
      title: `[TEST] PDF child ${Date.now()}`,
      meta: { distributionMethod: 'EMAIL' },
      recipients,
    } satisfies TCreateEnvelopePayload),
  );
  formData.append('files', new File([pdf], 'large.pdf', { type: 'application/pdf' }));

  return await request.post(`${apiUrl}/envelope/create`, {
    headers: owner.authHeaders,
    multipart: formData,
    timeout: 540_000,
  });
};

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 240_000, everyMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }

  return false;
};

// E2E_PDF_CHILD_DISABLED=true: the server runs with NEXT_PRIVATE_ST_PDF_CHILD_DISABLED=true, to make an
// in-process seal of the same file for comparison with a child seal.
const CHILD_EXPECTED = process.env.E2E_PDF_CHILD_DISABLED !== 'true';

test.describe('[PDF_CHILD] heavy PDF work runs in a child process', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  test('a large upload and its seal run in the PDF child; the document completes as usual', async ({ request }) => {
    test.skip(!LARGE_PDF_PATH || !fs.existsSync(LARGE_PDF_PATH), 'set E2E_LARGE_PDF_PATH to a 14-15 MB PDF');

    const pdf = fs.readFileSync(LARGE_PDF_PATH ?? '');
    const owner = await createOwner();
    const before = (await getHealth(request)).body.pdfChild?.runs ?? 0;

    const createRes = await createLarge(request, owner, pdf, [
      {
        email: uniqueEmail('signer'),
        name: 'Large Signer',
        role: RecipientRole.SIGNER,
        fields: [
          {
            type: 'SIGNATURE',
            page: 1,
            positionX: 10,
            positionY: 10,
            width: 10,
            height: 5,
            fieldMeta: { type: 'signature' },
          },
        ],
      },
    ]);
    expect(createRes.ok(), await createRes.text()).toBeTruthy();

    const { id: envelopeId }: TCreateEnvelopeResponse = await createRes.json();
    if (CHILD_EXPECTED) {
      expect((await getHealth(request)).body.pdfChild?.runs).toBeGreaterThan(before);
    }

    const distributeRes = await request.post(`${apiUrl}/envelope/distribute`, {
      headers: owner.authHeaders,
      data: { envelopeId },
      timeout: 540_000,
    });
    expect(distributeRes.ok(), await distributeRes.text()).toBeTruthy();

    const envelope = await prisma.envelope.findUniqueOrThrow({
      where: { id: envelopeId },
      include: { recipients: { include: { fields: true } } },
    });
    const [recipient] = envelope.recipients;
    const documentId = Number(envelope.secondaryId.split('_').pop());

    for (const field of recipient.fields) {
      const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
        data: JSON.stringify({
          json: { token: recipient.token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Large Signer' } },
        }),
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }

    const runsBeforeSeal = (await getHealth(request)).body.pdfChild?.runs ?? 0;

    const completeRes = await request.post(`${WEBAPP_BASE_URL}/api/trpc/recipient.completeDocumentWithToken`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify({ json: { token: recipient.token, documentId } }),
    });
    expect(completeRes.ok(), await completeRes.text()).toBeTruthy();

    expect(
      await waitFor(
        async () =>
          (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status === DocumentStatus.COMPLETED,
      ),
    ).toBe(true);

    // The seal ran in the child (one more child run), and finished as usual.
    if (CHILD_EXPECTED) {
      expect((await getHealth(request)).body.pdfChild?.runs).toBeGreaterThan(runsBeforeSeal);
    }
    expect(await prisma.documentAuditLog.count({ where: { envelopeId, type: 'DOCUMENT_COMPLETED' } })).toBe(1);

    expect(
      await waitFor(async () => {
        const job = await prisma.backgroundJob.findFirst({
          where: { jobId: 'send.document.completed.emails', payload: { path: ['envelopeId'], equals: envelopeId } },
        });

        return job?.status === 'COMPLETED';
      }, 120_000),
    ).toBe(true);
  });
});

/** Process ids of running PDF children on this machine (built: pdf-child.js; dev: vite-node pdf-child.ts). */
const findPdfChildPids = () => {
  try {
    return execSync("pgrep -f 'server/pdf-child'", { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
};

test.describe('[PDF_CHILD] a seal child killed mid-job', () => {
  test.describe.configure({ timeout: 600_000 });

  test('kill -9 of the seal child: the job runs again, the document completes once, one email job, one webhook', async ({
    request,
  }) => {
    test.skip(!LARGE_PDF_PATH || !fs.existsSync(LARGE_PDF_PATH), 'set E2E_LARGE_PDF_PATH to a 14-15 MB PDF');

    const pdf = fs.readFileSync(LARGE_PDF_PATH ?? '');
    const owner = await createOwner();

    // A webhook on the owner's team, to count the completion webhooks (delivery itself may fail).
    const webhook = await prisma.webhook.create({
      data: {
        webhookUrl: 'http://127.0.0.1:9/pdf-child-kill',
        eventTriggers: ['DOCUMENT_COMPLETED'],
        enabled: true,
        userId: owner.user.id,
        teamId: owner.team.id,
      },
    });

    const createRes = await createLarge(request, owner, pdf, [
      {
        email: uniqueEmail('killed'),
        name: 'Killed Seal',
        role: RecipientRole.SIGNER,
        fields: [
          {
            type: 'SIGNATURE',
            page: 1,
            positionX: 10,
            positionY: 10,
            width: 10,
            height: 5,
            fieldMeta: { type: 'signature' },
          },
        ],
      },
    ]);
    expect(createRes.ok(), await createRes.text()).toBeTruthy();
    const { id: envelopeId }: TCreateEnvelopeResponse = await createRes.json();

    expect(
      (
        await request.post(`${apiUrl}/envelope/distribute`, {
          headers: owner.authHeaders,
          data: { envelopeId },
          timeout: 540_000,
        })
      ).ok(),
    ).toBeTruthy();

    const envelope = await prisma.envelope.findUniqueOrThrow({
      where: { id: envelopeId },
      include: { recipients: { include: { fields: true } } },
    });
    const [recipient] = envelope.recipients;
    const documentId = Number(envelope.secondaryId.split('_').pop());

    for (const field of recipient.fields) {
      const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
        data: JSON.stringify({
          json: { token: recipient.token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Killed Seal' } },
        }),
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }

    // No other PDF child may be running now, so the one that appears is the seal's.
    expect(await waitFor(async () => findPdfChildPids().length === 0, 60_000)).toBe(true);

    const completeRes = await request.post(`${WEBAPP_BASE_URL}/api/trpc/recipient.completeDocumentWithToken`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify({ json: { token: recipient.token, documentId } }),
    });
    expect(completeRes.ok(), await completeRes.text()).toBeTruthy();

    // The seal runs PDF children (the page size, then the seal's PDF part); kill the first one seen,
    // without a chance to clean up.
    const killSealChild = async () => {
      const pids = await Promise.resolve(findPdfChildPids());

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');

          return true;
        } catch {
          // Already gone (a short child): look again.
        }
      }

      return false;
    };

    const childStatsBefore = (await getHealth(request)).body.pdfChild;
    const sawChild = await waitFor(killSealChild, 60_000, 100);

    test.skip(!sawChild, 'no PDF child process visible from the test (it runs on another host)');

    expect(
      await waitFor(
        async () =>
          (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status === DocumentStatus.COMPLETED,
      ),
    ).toBe(true);

    // Let follow-up jobs settle, then count.
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    const sealJob = await prisma.backgroundJob.findFirstOrThrow({
      where: { jobId: 'internal.seal-document', payload: { path: ['documentId'], equals: documentId } },
    });
    // Killed during its work: the attempt failed and the job ran again. Killed while it was still
    // starting (slow on the dev server): the work fell back to the app. Either way it was handled.
    const childStatsAfter = (await getHealth(request)).body.pdfChild;
    const handled =
      sealJob.retried >= 1 ||
      (childStatsAfter?.fallbacks ?? 0) > (childStatsBefore?.fallbacks ?? 0) ||
      (childStatsAfter?.failures ?? 0) > (childStatsBefore?.failures ?? 0);
    expect(handled, 'the killed child was handled (a retry or a fallback)').toBe(true);

    expect(await prisma.documentAuditLog.count({ where: { envelopeId, type: 'DOCUMENT_COMPLETED' } })).toBe(1);
    expect(
      await prisma.backgroundJob.count({
        where: { jobId: 'send.document.completed.emails', payload: { path: ['envelopeId'], equals: envelopeId } },
      }),
    ).toBe(1);
    expect(
      await prisma.backgroundJob.count({
        where: {
          jobId: 'internal.execute-webhook',
          AND: [
            { payload: { path: ['webhookId'], equals: webhook.id } },
            { payload: { path: ['event'], equals: 'DOCUMENT_COMPLETED' } },
          ],
        },
      }),
    ).toBe(1);
  });
});

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

test.describe('[PDF_CHILD] the app stays responsive and gives memory back', () => {
  test.describe.configure({ mode: 'serial', timeout: 1_200_000 });

  test('/api/health answers in under 200 ms (p95) while three 15 MB creates run', async ({ request }) => {
    test.skip(!LARGE_PDF_PATH || !fs.existsSync(LARGE_PDF_PATH), 'set E2E_LARGE_PDF_PATH to a 14-15 MB PDF');

    const pdf = fs.readFileSync(LARGE_PDF_PATH ?? '');
    const owner = await createOwner();
    const latencies: number[] = [];
    let isRunning = true;

    const sampler = (async () => {
      while (isRunning) {
        latencies.push((await getHealth(request)).ms);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    const responses = await Promise.all([1, 2, 3].map(async () => await createLarge(request, owner, pdf)));

    isRunning = false;
    await sampler;

    for (const res of responses) {
      expect(res.ok(), await res.text()).toBeTruthy();
    }

    const p95 = percentile(latencies, 95);
    console.log(
      `[PDF_CHILD] /api/health over ${latencies.length} samples: p50 ${percentile(latencies, 50)} ms, p95 ${p95} ms, max ${Math.max(...latencies)} ms`,
    );

    expect(latencies.length).toBeGreaterThan(20);
    expect(p95).toBeLessThan(200);
    // A long stall shows up as one slow sample, which p95 hides: bound the worst answer too.
    // With PDF work and base64 on the main thread it was 3,943 ms on the same machine.
    expect(Math.max(...latencies)).toBeLessThan(1_000);
  });

  test('after twenty large creates the app process is back near its starting memory', async ({ request }) => {
    test.skip(!LARGE_PDF_PATH || !fs.existsSync(LARGE_PDF_PATH), 'set E2E_LARGE_PDF_PATH to a 14-15 MB PDF');

    const pdf = fs.readFileSync(LARGE_PDF_PATH ?? '');
    const owner = await createOwner();

    // Warm up once, so the baseline includes the code paths and pools a create uses; then settle.
    expect((await createLarge(request, owner, pdf)).ok()).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    const baseline = (await getHealth(request)).body.memory?.rssMb ?? 0;
    let peak = baseline;

    for (let round = 0; round < 10; round++) {
      const responses = await Promise.all([1, 2].map(async () => await createLarge(request, owner, pdf)));

      for (const res of responses) {
        expect(res.ok(), await res.text()).toBeTruthy();
      }

      peak = Math.max(peak, (await getHealth(request)).body.memory?.rssMb ?? 0);
    }

    // Let the process settle.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const after = (await getHealth(request)).body.memory?.rssMb ?? 0;

    console.log(`[PDF_CHILD] app RSS: baseline ${baseline} MB, peak ${peak} MB, after twenty creates ${after} MB`);

    expect(baseline).toBeGreaterThan(0);
    // While they run, the app holds the uploads, not the PDF work (that is in the child): a few
    // hundred MB, where in-process PDF work and base64 took the app from 0.5 to about 2 GB.
    expect(peak - baseline).toBeLessThan(600);
    // Afterwards it is back near where it started. (On macOS idle pages are also compressed, so
    // this alone proves little there; the peak bound above does not depend on it.)
    expect(after - baseline).toBeLessThan(300);
  });
});

/** A child heap ceiling this low (16 MB) cannot process a 15 MB document; set it for both the server and the tests. */
const CHILD_MAX_MB = Number(process.env.NEXT_PRIVATE_ST_PDF_CHILD_MAX_MB ?? '0');

test.describe('[PDF_CHILD] a child that runs out of memory does not take the app down', () => {
  test.describe.configure({ timeout: 600_000 });

  test('a large upload whose child runs out of memory gets a clean 422; the app keeps serving', async ({ request }) => {
    test.skip(!LARGE_PDF_PATH || !fs.existsSync(LARGE_PDF_PATH), 'set E2E_LARGE_PDF_PATH to a 14-15 MB PDF');
    test.skip(
      !(CHILD_MAX_MB > 0 && CHILD_MAX_MB <= 256),
      'run the server and the tests with NEXT_PRIVATE_ST_PDF_CHILD_MAX_MB=16',
    );

    const pdf = fs.readFileSync(LARGE_PDF_PATH ?? '');
    const owner = await createOwner();
    const before = (await getHealth(request)).body.pdfChild?.failures ?? 0;

    const res = await createLarge(request, owner, pdf);
    const body = await res.text();

    expect(res.status(), body).toBe(422);
    expect(body).toContain('too large or complex to process');
    // LD4-L3: no internal detail (signal, timeout) in the answer; it is in the server log.
    expect(body).not.toMatch(/SIGABRT|SIGKILL|PDF process|within \d+ s/);

    const health = await getHealth(request);
    expect(health.body.pdfChild?.failures).toBe(before + 1);
    expect(health.ms).toBeLessThan(2_000);
  });
});
