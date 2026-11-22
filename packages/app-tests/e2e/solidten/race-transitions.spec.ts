/**
 * Races between recipient and envelope state transitions (FS2-C1 and the wider audit).
 *
 * Each case fires two conflicting requests at the same moment, many rounds, against the real
 * database and server, and checks that exactly one wins and the loser leaves nothing behind:
 * final state, audit entries and queued jobs.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, request as playwrightRequest, test } from '@playwright/test';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const API_V2 = `${WEBAPP_BASE_URL}/api/v2-beta`;

const ROUNDS = 30;

/**
 * Two separate HTTP clients, so the two sides of a race never share (and queue on) one
 * keep-alive connection.
 */
/**
 * The second side starts a little later each round (0 to 9 steps, with a sub-step offset per
 * ten rounds), so the rounds cover the window in which the first request is between its checks
 * and its write.
 */
const later = async <T>(round: number, call: () => Promise<T>, stepMs = 20) => {
  await new Promise((resolve) => setTimeout(resolve, (round % 10) * stepMs + Math.floor(round / 10) * (stepMs / 3)));

  return await call();
};

// The loser's body is read after the round, so the contexts stay open until the test ends.
const openClients: APIRequestContext[] = [];

const twoClients = async () => {
  const [a, b] = await Promise.all([playwrightRequest.newContext(), playwrightRequest.newContext()]);
  openClients.push(a, b);

  return { a, b, dispose: async () => {} };
};

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await Promise.all(openClients.splice(0).map(async (client) => await client.dispose()));
});

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

// A loaded test machine can take seconds per request; races are about order, not speed.
const REQUEST_TIMEOUT_MS = 90_000;

const trpcPost = async (request: APIRequestContext, path: string, json: unknown) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json }),
    timeout: REQUEST_TIMEOUT_MS,
  });

/** A pending document whose signers have filled every field, so completion can run. */
const seedReadyDocument = async (request: APIRequestContext, signerCount = 1) => {
  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] Race',
    recipients: Array.from({ length: signerCount }, (_, index) => ({
      email: uniqueEmail(`racer${index + 1}`),
      name: `Racer ${index + 1}`,
    })),
  });

  await prisma.field.updateMany({
    where: { envelopeId: seeded.envelope.id },
    data: { inserted: true, customText: 'Signed' },
  });

  // A signature field needs its signature row, or sealing refuses the document.
  const signatureFields = await prisma.field.findMany({
    where: { envelopeId: seeded.envelope.id, type: 'SIGNATURE' },
  });

  await prisma.signature.createMany({
    data: signatureFields.map((field) => ({
      fieldId: field.id,
      recipientId: field.recipientId,
      typedSignature: 'Racer',
    })),
  });

  const recipients = await prisma.recipient.findMany({
    where: { envelopeId: seeded.envelope.id },
    orderBy: { id: 'asc' },
  });

  return {
    ...seeded,
    recipients,
    documentId: mapSecondaryIdToDocumentId(seeded.envelope.secondaryId),
  };
};

const complete = async (request: APIRequestContext, token: string, documentId: number) =>
  await trpcPost(request, 'recipient.completeDocumentWithToken', { token, documentId });

const rejectAsSigner = async (request: APIRequestContext, token: string, documentId: number) =>
  await trpcPost(request, 'recipient.rejectDocumentWithToken', { token, documentId, reason: 'Second tab' });

const apiPost = async (request: APIRequestContext, apiToken: string, path: string, data: unknown) =>
  await request.post(`${API_V2}${path}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    data,
    timeout: REQUEST_TIMEOUT_MS,
  });

const isWin = (response: APIResponse) => response.ok();

/**
 * The loser answers a plain 4xx (RACE-L1): no 500 and no database text.
 */
const expectCleanLoss = async (response: APIResponse) => {
  expect(response.ok()).toBe(false);
  expect(response.status(), 'the loser answers 4xx, not 5xx').toBeGreaterThanOrEqual(400);
  expect(response.status(), 'the loser answers 4xx, not 5xx').toBeLessThan(500);

  const body = await response.text();
  expect(body).not.toMatch(/prisma\.|Invalid `|P20\d\d/i);
};

const countAudit = async (envelopeId: string, type: string, recipientId: number) =>
  (await prisma.documentAuditLog.findMany({ where: { envelopeId, type } })).filter(
    (log) => (log.data as { recipientId?: number }).recipientId === recipientId,
  ).length;

const countJobs = async (jobId: string, documentId: number) =>
  await prisma.backgroundJob.count({ where: { jobId, payload: { path: ['documentId'], equals: documentId } } });

/**
 * Completion against a decline of the same recipient: exactly one wins, and the end state,
 * audit entries and jobs match the winner only.
 */
const expectCompleteOrRejectWinner = async ({
  envelopeId,
  documentId,
  recipientId,
  completeResponse,
  rejectResponse,
}: {
  envelopeId: string;
  documentId: number;
  recipientId: number;
  completeResponse: APIResponse;
  rejectResponse: APIResponse;
}) => {
  const completed = isWin(completeResponse);
  const rejected = isWin(rejectResponse);

  if (process.env.RACE_DEBUG) {
    console.log(
      'RACE',
      completed ? 'C' : '-',
      rejected ? 'R' : '-',
      completeResponse.status(),
      rejectResponse.status(),
    );
  }

  expect(Number(completed) + Number(rejected), 'exactly one of complete and reject wins').toBe(1);
  await expectCleanLoss(completed ? rejectResponse : completeResponse);

  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });

  if (completed) {
    expect(recipient.signingStatus).toBe('SIGNED');
    expect(recipient.rejectionReason).toBeNull();
  } else {
    expect(recipient.signingStatus).toBe('REJECTED');
  }

  expect(await countAudit(envelopeId, DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED, recipientId)).toBe(
    completed ? 1 : 0,
  );
  expect(await countAudit(envelopeId, DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED, recipientId)).toBe(
    rejected ? 1 : 0,
  );

  // One seal job, and the decline emails only for a decline.
  expect(await countJobs('internal.seal-document', documentId)).toBe(1);
  expect(await countJobs('send.signing.rejected.emails', documentId)).toBe(rejected ? 1 : 0);
};

test('[RACE] FS2-C1: the signer declining in a second tab races their completion: one winner', async ({ request }) => {
  test.setTimeout(600_000);

  for (let round = 0; round < ROUNDS; round++) {
    const { envelope, recipients, documentId } = await seedReadyDocument(request);
    const [signer] = recipients;

    const clients = await twoClients();
    const [completeResponse, rejectResponse] = await Promise.all([
      complete(clients.a, signer.token, documentId),
      later(round, async () => rejectAsSigner(clients.b, signer.token, documentId)),
    ]);
    await clients.dispose();

    await expectCompleteOrRejectWinner({
      envelopeId: envelope.id,
      documentId,
      recipientId: signer.id,
      completeResponse,
      rejectResponse,
    });
  }
});

test('[RACE] FS2-C1: the owner declining on behalf races the completion: one winner', async ({ request }) => {
  test.setTimeout(600_000);

  for (let round = 0; round < ROUNDS; round++) {
    const { envelope, recipients, documentId, token: apiToken } = await seedReadyDocument(request);
    const [signer] = recipients;

    const clients = await twoClients();
    const [completeResponse, rejectResponse] = await Promise.all([
      complete(clients.a, signer.token, documentId),
      later(round, async () =>
        apiPost(clients.b, apiToken, `/envelope/recipient/${signer.id}/reject`, {
          envelopeId: envelope.id,
          recipientId: signer.id,
          reason: 'Declined by phone',
        }),
      ),
    ]);
    await clients.dispose();

    await expectCompleteOrRejectWinner({
      envelopeId: envelope.id,
      documentId,
      recipientId: signer.id,
      completeResponse,
      rejectResponse,
    });
  }
});

test('[RACE] a reassignment races the old link completing: never both', async ({ request }) => {
  test.setTimeout(600_000);

  for (let round = 0; round < ROUNDS; round++) {
    const { envelope, recipients, documentId, token: apiToken } = await seedReadyDocument(request);
    const [signer] = recipients;
    const newEmail = uniqueEmail('handed');

    const clients = await twoClients();
    const [completeResponse, reassignResponse] = await Promise.all([
      complete(clients.a, signer.token, documentId),
      later(
        round,
        async () =>
          apiPost(clients.b, apiToken, '/envelope/recipient/reassign', {
            envelopeId: envelope.id,
            recipientId: signer.id,
            name: 'New Person',
            email: newEmail,
          }),
        60,
      ),
    ]);
    await clients.dispose();

    const completed = isWin(completeResponse);
    const reassigned = isWin(reassignResponse);

    expect(Number(completed) + Number(reassigned), 'exactly one wins').toBe(1);
    await expectCleanLoss(completed ? reassignResponse : completeResponse);

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: signer.id } });

    if (completed) {
      // The old person signed with their own link; the request was not handed on.
      expect(after).toMatchObject({ signingStatus: 'SIGNED', email: signer.email, token: signer.token });
      expect(await countAudit(envelope.id, 'RECIPIENT_REASSIGNED', signer.id)).toBe(0);
    } else {
      // Handed on: the new person has a new link and nothing was signed with the old one.
      expect(after.signingStatus).toBe('NOT_SIGNED');
      expect(after.email).toBe(newEmail);
      expect(after.token).not.toBe(signer.token);
      expect(await countAudit(envelope.id, DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED, signer.id)).toBe(0);
      expect(await countJobs('internal.seal-document', documentId)).toBe(0);
    }
  }
});

test('[RACE] a sender email edit (update-many) races the completion: never both', async ({ request }) => {
  test.setTimeout(600_000);

  for (let round = 0; round < ROUNDS; round++) {
    const { envelope, recipients, documentId, token: apiToken } = await seedReadyDocument(request);
    const [signer] = recipients;
    const newEmail = uniqueEmail('edited');

    const clients = await twoClients();
    const [completeResponse, editResponse] = await Promise.all([
      complete(clients.a, signer.token, documentId),
      later(
        round,
        async () =>
          apiPost(clients.b, apiToken, '/envelope/recipient/update-many', {
            envelopeId: envelope.id,
            data: [{ id: signer.id, email: newEmail, name: 'Edited Person' }],
          }),
        60,
      ),
    ]);
    await clients.dispose();

    const completed = isWin(completeResponse);
    const edited = isWin(editResponse);

    expect(Number(completed) + Number(edited), 'exactly one wins').toBe(1);
    await expectCleanLoss(completed ? editResponse : completeResponse);

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: signer.id } });

    if (completed) {
      // The edit did not turn a signed recipient back into an unsigned one.
      expect(after).toMatchObject({ signingStatus: 'SIGNED', email: signer.email });
    } else {
      expect(after).toMatchObject({ signingStatus: 'NOT_SIGNED', email: newEmail });
      expect(await countAudit(envelope.id, DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED, signer.id)).toBe(0);
    }
  }
});

test('[RACE] removing a recipient races their completion: never both', async ({ request }) => {
  test.setTimeout(600_000);

  for (let round = 0; round < ROUNDS; round++) {
    const { envelope, recipients, documentId, token: apiToken } = await seedReadyDocument(request, 2);
    const [, second] = recipients;

    // The API refuses to remove someone who touched the document; start from a clean slate.
    await prisma.field.updateMany({ where: { recipientId: second.id }, data: { inserted: false, customText: '' } });

    const clients = await twoClients();
    const [completeResponse, deleteResponse] = await Promise.all([
      // Re-fill just before completing, as the signing page would.
      prisma.field
        .updateMany({ where: { recipientId: second.id }, data: { inserted: true, customText: 'Signed' } })
        .then(async () => await complete(clients.a, second.token, documentId)),
      later(
        round,
        async () => apiPost(clients.b, apiToken, '/envelope/recipient/delete', { recipientId: second.id }),
        60,
      ),
    ]);
    await clients.dispose();

    const completed = isWin(completeResponse);
    const deleted = isWin(deleteResponse);

    expect(Number(completed) + Number(deleted), 'at most one wins').toBeLessThanOrEqual(1);

    const after = await prisma.recipient.findUnique({ where: { id: second.id } });

    if (completed) {
      expect(after?.signingStatus).toBe('SIGNED');
    }

    if (deleted) {
      expect(after).toBeNull();
      expect(await countAudit(envelope.id, DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED, second.id)).toBe(0);
    }

    // A signed recipient is never removed.
    expect(completed && after === null).toBe(false);
  }
});

test('[RACE] two signers decline at the same moment: one decline', async ({ request }) => {
  test.setTimeout(600_000);

  for (let round = 0; round < ROUNDS; round++) {
    const { envelope, recipients, documentId } = await seedReadyDocument(request, 2);
    const [first, second] = recipients;

    const clients = await twoClients();
    const responses = await Promise.all([
      rejectAsSigner(clients.a, first.token, documentId),
      later(round, async () => rejectAsSigner(clients.b, second.token, documentId)),
    ]);
    await clients.dispose();

    expect(responses.filter(isWin)).toHaveLength(1);
    await expectCleanLoss(responses.find((response) => !response.ok()) as APIResponse);

    const rejected = await prisma.recipient.count({ where: { envelopeId: envelope.id, signingStatus: 'REJECTED' } });
    expect(rejected).toBe(1);

    const rejectionAudits = await prisma.documentAuditLog.count({
      where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED },
    });
    expect(rejectionAudits).toBe(1);
    expect(await countJobs('internal.seal-document', documentId)).toBe(1);
  }
});

/* -------------------------------------------------------------------------- */
/*     Held interleavings: the other side commits while this request waits    */
/* -------------------------------------------------------------------------- */

/**
 * Hold the envelope lock in a transaction of our own (as a completion, decline or cancel does),
 * apply that writer's change, fire `request` while the lock is held, then commit. The request
 * has read the old state and now meets the new one: the exact interleaving a slow race needs.
 */
const whileHoldingEnvelope = async <T>(
  envelopeId: string,
  change: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
  request: () => Promise<T>,
) => {
  let pending: Promise<T> | null = null;

  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR UPDATE`;
      await change(tx);

      pending = request();

      // Long enough for the request to read the old state and reach its write.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    },
    { timeout: 20_000 },
  );

  return (await pending) as unknown as T;
};

const HELD_ROUNDS = 30;

test('[RACE] held: an editor save that read the recipient before they signed does not unsign them', async ({
  request,
}) => {
  test.setTimeout(900_000);

  for (let round = 0; round < HELD_ROUNDS; round++) {
    const { envelope, recipients, token: apiToken } = await seedReadyDocument(request);
    const [signer] = recipients;

    // The editor only lets a sender change someone who has not filled anything yet.
    await prisma.field.updateMany({ where: { recipientId: signer.id }, data: { inserted: false, customText: '' } });

    const edit = await whileHoldingEnvelope(
      envelope.id,
      async (tx) =>
        await tx.recipient.update({
          where: { id: signer.id },
          data: { signingStatus: 'SIGNED', signedAt: new Date() },
        }),
      async () =>
        await apiPost(request, apiToken, '/envelope/recipient/update-many', {
          envelopeId: envelope.id,
          data: [{ id: signer.id, name: 'Renamed While Signing' }],
        }),
    );

    await expectCleanLoss(edit);
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: signer.id } })).signingStatus).toBe('SIGNED');
  }
});

test('[RACE] held: the old link cannot complete after the request was handed to someone else', async ({ request }) => {
  test.setTimeout(900_000);

  for (let round = 0; round < HELD_ROUNDS; round++) {
    const { envelope, recipients, documentId } = await seedReadyDocument(request);
    const [signer] = recipients;
    const newEmail = uniqueEmail('handed-held');

    const completion = await whileHoldingEnvelope(
      envelope.id,
      async (tx) =>
        await tx.recipient.update({
          where: { id: signer.id },
          data: { email: newEmail, name: 'New Person', token: `held-${Date.now()}-${round}` },
        }),
      async () => await complete(request, signer.token, documentId),
    );

    await expectCleanLoss(completion);

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: signer.id } });
    expect(after).toMatchObject({ signingStatus: 'NOT_SIGNED', email: newEmail });
    expect(await countAudit(envelope.id, DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED, signer.id)).toBe(0);
  }
});

test('[RACE] held: a recipient who signed while their removal waited is not removed', async ({ request }) => {
  test.setTimeout(900_000);

  for (let round = 0; round < HELD_ROUNDS; round++) {
    const { envelope, recipients, token: apiToken } = await seedReadyDocument(request, 2);
    const [, second] = recipients;

    await prisma.field.updateMany({ where: { recipientId: second.id }, data: { inserted: false, customText: '' } });

    const removal = await whileHoldingEnvelope(
      envelope.id,
      async (tx) =>
        await tx.recipient.update({
          where: { id: second.id },
          data: { signingStatus: 'SIGNED', signedAt: new Date() },
        }),
      async () => await apiPost(request, apiToken, '/envelope/recipient/delete', { recipientId: second.id }),
    );

    await expectCleanLoss(removal);
    expect(await prisma.recipient.findUnique({ where: { id: second.id } })).not.toBeNull();
  }
});

test('[RACE] held: a reassignment waiting on a cancellation does not hand on a cancelled request', async ({
  request,
}) => {
  test.setTimeout(900_000);

  for (let round = 0; round < HELD_ROUNDS; round++) {
    const { envelope, recipients, token: apiToken } = await seedReadyDocument(request);
    const [signer] = recipients;

    const reassign = await whileHoldingEnvelope(
      envelope.id,
      async (tx) => await tx.envelope.update({ where: { id: envelope.id }, data: { status: 'CANCELLED' } }),
      async () =>
        await apiPost(request, apiToken, '/envelope/recipient/reassign', {
          envelopeId: envelope.id,
          recipientId: signer.id,
          name: 'Too Late',
          email: uniqueEmail('too-late'),
        }),
    );

    await expectCleanLoss(reassign);

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: signer.id } });
    expect(after).toMatchObject({ email: signer.email, token: signer.token });
    expect(await countAudit(envelope.id, 'RECIPIENT_REASSIGNED', signer.id)).toBe(0);
  }
});

test('[SEC3-L1] a loser is told what actually happened', async ({ request }) => {
  const { envelope, recipients, documentId, token: apiToken } = await seedReadyDocument(request, 2);
  const [decliner, other] = recipients;

  // The decline has landed; the seal has not run yet (no job is queued here).
  await prisma.recipient.update({
    where: { id: decliner.id },
    data: { signingStatus: 'REJECTED', signedAt: new Date(), rejectionReason: 'No' },
  });

  const expectRefusal = async (response: APIResponse, text: string) => {
    const body = await response.text();

    expect(response.status(), body).toBe(400);
    expect(body).toContain(text);
  };

  // The same recipient, from a second tab: their own decline, not "another recipient".
  await expectRefusal(
    await rejectAsSigner(request, decliner.token, documentId),
    'This recipient has already signed or declined',
  );
  await expectRefusal(
    await complete(request, decliner.token, documentId),
    'This recipient has already signed or declined',
  );

  // Another recipient: someone else declined.
  await expectRefusal(await complete(request, other.token, documentId), 'Another recipient declined this document');

  // The sender cancelling now: a decline, never "Everyone has signed".
  const cancel = await apiPost(request, apiToken, '/envelope/cancel', { envelopeId: envelope.id });
  const cancelBody = await cancel.text();
  expect(cancel.ok()).toBe(false);
  expect(cancelBody).toContain('A recipient declined this document');
  expect(cancelBody).not.toContain('Everyone has signed');

  // When everyone has signed, the cancel refusal says so.
  await prisma.recipient.updateMany({
    where: { envelopeId: envelope.id },
    data: { signingStatus: 'SIGNED', rejectionReason: null },
  });

  const cancelSigned = await apiPost(request, apiToken, '/envelope/cancel', { envelopeId: envelope.id });
  expect(cancelSigned.ok()).toBe(false);
  expect(await cancelSigned.text()).toContain('Everyone has signed');
});
