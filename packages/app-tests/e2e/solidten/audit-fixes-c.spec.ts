import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { removeSignedFieldWithToken } from '@documenso/lib/server-only/field/remove-signed-field-with-token';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { createDocumentFromDirectTemplate } from '@documenso/lib/server-only/template/create-document-from-direct-template';
import { createWebhook } from '@documenso/lib/server-only/webhooks/create-webhook';
import { editWebhook } from '@documenso/lib/server-only/webhooks/edit-webhook';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { getRecipientCommentThreadKey } from '@documenso/lib/utils/envelope-comments';
import { prisma } from '@documenso/prisma';
import {
  DocumentSigningOrder,
  FieldType,
  RecipientRole,
  SendStatus,
  SigningStatus,
  TeamMemberRole,
} from '@documenso/prisma/client';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Browser } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten: regression tests for the audit fixes of 11/21 (builder C, low findings).
 * Each test names its finding.
 */

test.describe.configure({ mode: 'serial' });

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold every matching insert or update on one table for `seconds`, inside the writer's own
 * transaction, so a request stops at a known point. `when` is a plpgsql condition on NEW/OLD.
 */
const holdWrites = async (name: string, table: string, event: 'INSERT' | 'UPDATE', when: string, seconds: number) => {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN
      IF ${when} THEN
        PERFORM pg_sleep(${seconds});
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );

  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  };
};

/** Hold the insert of one background job for one envelope. */
const holdJobInsert = async (name: string, jobId: string, envelopeId: string, seconds: number) =>
  await holdWrites(
    name,
    'BackgroundJob',
    'INSERT',
    `NEW."jobId" = '${jobId}' AND NEW."payload"->>'envelopeId' = '${envelopeId}'`,
    seconds,
  );

const seedSequentialDictation = async () => {
  const { user, team } = await seedUser();
  const [firstSigner, secondSigner] = [(await seedUser()).user, (await seedUser()).user];

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [firstSigner, secondSigner],
    recipientsCreateOptions: [
      { signingOrder: 1, sendStatus: SendStatus.SENT },
      // The next signer already holds a link (for example one the sender shared by hand).
      { signingOrder: 2, sendStatus: SendStatus.SENT },
    ],
    fields: [],
    updateDocumentOptions: {
      internalVersion: 2,
      documentMeta: {
        upsert: {
          create: { signingOrder: DocumentSigningOrder.SEQUENTIAL, allowDictateNextSigner: true },
          update: { signingOrder: DocumentSigningOrder.SEQUENTIAL, allowDictateNextSigner: true },
        },
      },
    },
  });

  const first = recipients.find((recipient) => recipient.email === firstSigner.email);
  const second = recipients.find((recipient) => recipient.email === secondSigner.email);

  if (!first || !second) {
    throw new Error('Seeded recipients are missing');
  }

  return { document, first, second };
};

test('[AUD-C1]: a dictated next signer never overwrites a next recipient who signed in the meantime', async () => {
  const { document, first, second } = await seedSequentialDictation();

  // The first signer's request stops after it read the pending recipients and before the dictation.
  const release = await holdJobInsert('audit_c1_hold', 'send.document.pending.email', document.id, 4);

  try {
    const firstDone = completeDocumentWithToken({
      token: first.token,
      id: { type: 'envelopeId', id: document.id },
      nextSigner: { name: 'Dictated Person', email: uniqueEmail('dictated') },
      requestMetadata: { userAgent: 'audit-c1' },
    });

    // The first signer has committed: it is now the second signer's turn, and they complete.
    await expect
      .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: first.id } })).signingStatus, {
        timeout: 10_000,
      })
      .toBe(SigningStatus.SIGNED);
    await sleep(200);

    await completeDocumentWithToken({
      token: second.token,
      id: { type: 'envelopeId', id: document.id },
      requestMetadata: { userAgent: 'audit-c1' },
    });

    await firstDone;
  } finally {
    await release();
  }

  const secondAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: second.id } });

  expect(secondAfter.signingStatus).toBe(SigningStatus.SIGNED);
  expect(secondAfter.email).toBe(second.email);
  expect(secondAfter.name).toBe(second.name);
  expect(secondAfter.token).toBe(second.token);

  const reassigned = await prisma.documentAuditLog.count({
    where: { envelopeId: document.id, type: 'RECIPIENT_REASSIGNED' },
  });
  expect(reassigned).toBe(0);
});

test('[AUD-C1]: a dictation does not run after the sender cancelled the document', async () => {
  const { document, first, second } = await seedSequentialDictation();

  const release = await holdJobInsert('audit_c1_cancel', 'send.document.pending.email', document.id, 3);

  try {
    const firstDone = completeDocumentWithToken({
      token: first.token,
      id: { type: 'envelopeId', id: document.id },
      nextSigner: { name: 'Dictated Person', email: uniqueEmail('dictated') },
    });

    await expect
      .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: first.id } })).signingStatus, {
        timeout: 10_000,
      })
      .toBe(SigningStatus.SIGNED);

    // The sender cancels while the first signer's request is still running.
    await prisma.envelope.update({ where: { id: document.id }, data: { status: 'CANCELLED' } });

    await firstDone.catch(() => undefined);
  } finally {
    await release();
  }

  const secondAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: second.id } });

  expect(secondAfter.email).toBe(second.email);
  expect(secondAfter.token).toBe(second.token);

  const signingRequests = await prisma.backgroundJob.count({
    where: { jobId: 'send.signing.requested.email', payload: { path: ['recipientId'], equals: second.id } },
  });
  expect(signingRequests).toBe(0);
});

/** One signer on a version-2 document, with a signed (filled) signature field. */
const seedSignedSignatureField = async () => {
  const { user, team } = await seedUser();
  const { user: signer } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [signer],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  const [recipient] = recipients;
  const field = await prisma.field.findFirstOrThrow({ where: { recipientId: recipient.id } });

  await prisma.field.update({ where: { id: field.id }, data: { inserted: true, customText: '' } });
  await prisma.signature.create({ data: { fieldId: field.id, recipientId: recipient.id, typedSignature: 'Signer' } });

  return { document, recipient, field };
};

const expectNeverSignedWithEmptyField = async (recipientId: number, fieldId: number) => {
  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId }, include: { signature: true } });

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    expect(field.inserted, 'a SIGNED recipient keeps their signature field').toBe(true);
    expect(field.signature).not.toBeNull();
  }

  return { recipient, field };
};

test('[AUD-C2]: an uninsert that is writing when the signer completes wins, and the completion is refused', async () => {
  const { document, recipient, field } = await seedSignedSignatureField();

  // The uninsert stops inside its own write, after its checks.
  const release = await holdWrites(
    'audit_c2_uninsert',
    'Field',
    'UPDATE',
    `OLD."inserted" AND NOT NEW."inserted" AND NEW."id" = ${field.id}`,
    3,
  );

  let completion: unknown = null;

  try {
    const uninsert = removeSignedFieldWithToken({ token: recipient.token, fieldId: field.id });

    await sleep(500);

    completion = await completeDocumentWithToken({
      token: recipient.token,
      id: { type: 'envelopeId', id: document.id },
    }).then(
      () => 'completed',
      (error: unknown) => error,
    );

    await uninsert;
  } finally {
    await release();
  }

  const after = await expectNeverSignedWithEmptyField(recipient.id, field.id);

  expect(after.field.inserted).toBe(false);
  expect(after.recipient.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  expect(String(completion)).toContain('unsigned fields');
});

test('[AUD-C2]: a field write that arrives while the signer completes is refused under the lock', async ({
  request,
}) => {
  const { document, recipient, field } = await seedSignedSignatureField();

  // The completion stops inside its locked transaction, in the SIGNED write.
  const release = await holdWrites(
    'audit_c2_complete',
    'Recipient',
    'UPDATE',
    `NEW."signingStatus" = 'SIGNED' AND OLD."signingStatus" <> 'SIGNED' AND NEW."id" = ${recipient.id}`,
    3,
  );

  let uninsertStatus = 0;

  try {
    const completion = completeDocumentWithToken({
      token: recipient.token,
      id: { type: 'envelopeId', id: document.id },
    });

    await sleep(800);

    // Version-2 route: a null signature value uninserts the field.
    const response = await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify({
        json: { token: recipient.token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: null } },
      }),
    });
    uninsertStatus = response.status();

    await completion;
  } finally {
    await release();
  }

  const after = await expectNeverSignedWithEmptyField(recipient.id, field.id);

  expect(after.recipient.signingStatus).toBe(SigningStatus.SIGNED);
  expect(uninsertStatus).toBe(400);
});

const trpcPost = async (request: APIRequestContext, path: string, json: unknown) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json }),
  });

test('[AUD-C3]: an assistant token is refused on both legacy field routes of a document with field rules', async ({
  request,
}) => {
  const { user, team } = await seedUser();
  const [assistantUser, signerUser] = [(await seedUser()).user, (await seedUser()).user];

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [assistantUser, signerUser],
    recipientsCreateOptions: [
      { signingOrder: 1, role: RecipientRole.ASSISTANT },
      { signingOrder: 2, role: RecipientRole.SIGNER },
    ],
    fields: [FieldType.TEXT],
    updateDocumentOptions: {
      internalVersion: 2,
      documentMeta: {
        upsert: {
          create: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
          update: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        },
      },
    },
  });

  const assistant = recipients.find((recipient) => recipient.email === assistantUser.email);
  const signer = recipients.find((recipient) => recipient.email === signerUser.email);

  if (!assistant || !signer) {
    throw new Error('Seeded recipients are missing');
  }

  // The later signer's field takes part in field rules (it has a field key).
  const signerField = await prisma.field.findFirstOrThrow({ where: { recipientId: signer.id } });
  await prisma.field.update({
    where: { id: signerField.id },
    data: { fieldMeta: { type: 'text', fieldKey: 'amount' } },
  });

  const signRes = await trpcPost(request, 'field.signFieldWithToken', {
    token: assistant.token,
    fieldId: signerField.id,
    value: 'forged',
    isBase64: false,
  });
  expect(signRes.status()).toBe(400);
  expect(await signRes.text()).toContain('field rules');

  const fieldAfterSign = await prisma.field.findUniqueOrThrow({ where: { id: signerField.id } });
  expect(fieldAfterSign.inserted).toBe(false);

  // The uninsert route is refused the same way, even on a filled field.
  await prisma.field.update({ where: { id: signerField.id }, data: { inserted: true, customText: '42' } });

  const removeRes = await trpcPost(request, 'field.removeSignedFieldWithToken', {
    token: assistant.token,
    fieldId: signerField.id,
  });
  expect(removeRes.status()).toBe(400);
  expect(await removeRes.text()).toContain('field rules');

  const fieldAfterRemove = await prisma.field.findUniqueOrThrow({ where: { id: signerField.id } });
  expect(fieldAfterRemove.customText).toBe('42');
});

const directRequestMetadata: ApiRequestMetadata = { requestMetadata: {}, source: 'app', auth: null };

/** A version-1 direct template (no public form) with dictation on and a later signer. */
const seedPlainDirectTemplate = async () => {
  const { user, team } = await seedUser();

  const template = await seedDirectTemplate({ title: '[TEST] Plain direct link', userId: user.id, teamId: team.id });

  await prisma.documentMeta.update({
    where: { id: template.documentMetaId },
    data: { signingOrder: DocumentSigningOrder.SEQUENTIAL, allowDictateNextSigner: true },
  });

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

  const later = await prisma.recipient.create({
    data: {
      envelopeId: template.id,
      email: uniqueEmail('later'),
      name: 'Later Signer',
      token: Math.random().toString().slice(2, 12),
      role: RecipientRole.SIGNER,
      signingOrder: 2,
    },
  });

  await prisma.field.create({
    data: {
      envelopeId: template.id,
      envelopeItemId: envelopeItem.id,
      recipientId: later.id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: 5,
      positionY: 40,
      width: 20,
      height: 5,
      customText: '',
      inserted: false,
    },
  });

  const directSignatureField = template.fields.find((field) => field.type === FieldType.SIGNATURE);

  if (!template.directLink || !directSignatureField) {
    throw new Error('Seeded direct template is missing its link or signature field');
  }

  const refreshed = await prisma.envelope.findFirstOrThrow({ where: { id: template.id } });

  return {
    token: template.directLink.token,
    fieldId: directSignatureField.id,
    templateUpdatedAt: refreshed.updatedAt,
  };
};

const submitPlainDirectLink = async (
  seeded: Awaited<ReturnType<typeof seedPlainDirectTemplate>>,
  options: {
    email: string;
    name?: string;
    nextSigner?: { email: string; name: string };
    user?: { id: number; name?: string; email: string };
    nameFieldValue?: string;
  },
) =>
  await createDocumentFromDirectTemplate({
    directRecipientName: options.name,
    directRecipientEmail: options.email,
    directTemplateToken: seeded.token,
    templateUpdatedAt: seeded.templateUpdatedAt,
    signedFieldValues: [{ token: seeded.token, fieldId: seeded.fieldId, value: 'Typed Signature', isBase64: false }],
    nextSigner: options.nextSigner,
    user: options.user,
    requestMetadata: directRequestMetadata,
  });

test('[AUD-C4]: a stranger on a plain direct link cannot dictate the next signer', async () => {
  const seeded = await seedPlainDirectTemplate();

  await expect(
    submitPlainDirectLink(seeded, {
      email: uniqueEmail('stranger'),
      name: 'Stranger',
      nextSigner: { email: uniqueEmail('victim'), name: 'Victim' },
    }),
  ).rejects.toThrow('Sign in with this email address before you choose the next signer.');
});

test('[AUD-C4]: a stranger on a plain direct link gets no email to the typed address', async () => {
  const seeded = await seedPlainDirectTemplate();

  const { envelopeId, recipientId } = await submitPlainDirectLink(seeded, {
    email: uniqueEmail('stranger'),
    name: 'Stranger',
  });

  // Solid Ten Sign (AUD-C4 follow-up): only the typed address is marked; the document's email
  // settings stay as the owner set them (mail checks: audit-fixes-e.spec.ts).
  const direct = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });
  expect(direct.unverifiedEmailAt).not.toBeNull();

  const others = await prisma.recipient.findMany({ where: { envelopeId, id: { not: recipientId } } });
  expect(others.every((recipient) => recipient.unverifiedEmailAt === null)).toBe(true);
});

test('[AUD-C4]: a signer signed in with the typed email may still dictate the next signer', async () => {
  const seeded = await seedPlainDirectTemplate();
  const { user: signer } = await seedUser();
  const dictated = uniqueEmail('dictated');

  const { envelopeId } = await submitPlainDirectLink(seeded, {
    email: signer.email,
    user: { id: signer.id, name: signer.name ?? undefined, email: signer.email },
    nextSigner: { email: dictated, name: 'Dictated Signer' },
  });

  const recipients = await prisma.recipient.findMany({ where: { envelopeId } });
  expect(recipients.some((recipient) => recipient.email === dictated)).toBe(true);
});

const DIRTY_NAME = 'Eve\u202Elivne\u200B\nSecond line';
const CLEAN_NAME = 'Evelivne Second line';

test('[AUD-C5]: a dictated next signer name is stored as one clean line', async () => {
  const seeded = await seedPlainDirectTemplate();
  const { user: signer } = await seedUser();
  const dictated = uniqueEmail('dictated');

  const { envelopeId } = await submitPlainDirectLink(seeded, {
    email: signer.email,
    user: { id: signer.id, name: signer.name ?? undefined, email: signer.email },
    nextSigner: { email: dictated, name: DIRTY_NAME },
  });

  const stored = await prisma.recipient.findFirstOrThrow({ where: { envelopeId, email: dictated } });
  expect(stored.name).toBe(CLEAN_NAME);
});

test('[AUD-C5]: a name taken from the NAME field is stored as one clean line', async () => {
  const seeded = await seedPlainDirectTemplate();

  const template = await prisma.envelope.findFirstOrThrow({
    where: { directLink: { token: seeded.token } },
    include: { recipients: true },
  });
  const directRecipient = template.recipients.find((recipient) => recipient.signingOrder === 1);
  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

  const nameField = await prisma.field.create({
    data: {
      envelopeId: template.id,
      envelopeItemId: envelopeItem.id,
      recipientId: directRecipient?.id ?? 0,
      type: FieldType.NAME,
      page: 1,
      positionX: 5,
      positionY: 60,
      width: 20,
      height: 5,
      customText: '',
      inserted: false,
    },
  });

  const refreshed = await prisma.envelope.findFirstOrThrow({ where: { id: template.id } });
  const email = uniqueEmail('stranger');

  const { envelopeId } = await createDocumentFromDirectTemplate({
    directRecipientEmail: email,
    directTemplateToken: seeded.token,
    templateUpdatedAt: refreshed.updatedAt,
    signedFieldValues: [
      { token: seeded.token, fieldId: seeded.fieldId, value: 'Typed Signature', isBase64: false },
      { token: seeded.token, fieldId: nameField.id, value: DIRTY_NAME, isBase64: false },
    ],
    requestMetadata: directRequestMetadata,
  });

  const stored = await prisma.recipient.findFirstOrThrow({ where: { envelopeId, email } });
  expect(stored.name).toBe(CLEAN_NAME);
});

// A name that never resolves (RFC 6761), so the address check would answer "could not be resolved".
const UNRESOLVABLE_WEBHOOK_URL = 'https://audit-c7-probe.invalid/hook';

test('[AUD-C7]: zapier subscribe answers 401 to a bad token before any address check', async ({ request }) => {
  const response = await request.post(`${WEBAPP_BASE_URL}/api/v1/zapier/subscribe`, {
    headers: { Authorization: 'api_not_a_real_token', 'content-type': 'application/json' },
    data: { webhookUrl: UNRESOLVABLE_WEBHOOK_URL, eventTrigger: 'DOCUMENT_SIGNED' },
  });

  expect(response.status()).toBe(401);
  expect(await response.text()).not.toContain('could not be resolved');
});

test('[AUD-C7]: webhook create and edit check MANAGE_TEAM before any address check', async () => {
  const { user: owner, team } = await seedUser();
  const member = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MEMBER });

  await expect(
    createWebhook({
      webhookUrl: UNRESOLVABLE_WEBHOOK_URL,
      eventTriggers: ['DOCUMENT_SIGNED'],
      secret: null,
      enabled: true,
      userId: member.id,
      teamId: team.id,
    }),
  ).rejects.toThrow('Team not found');

  const webhook = await prisma.webhook.create({
    data: {
      webhookUrl: 'https://example.com/hook',
      eventTriggers: ['DOCUMENT_SIGNED'],
      enabled: true,
      userId: owner.id,
      teamId: team.id,
    },
  });

  await expect(
    editWebhook({ id: webhook.id, data: { webhookUrl: UNRESOLVABLE_WEBHOOK_URL }, userId: member.id, teamId: team.id }),
  ).rejects.toThrow('Webhook not found');

  expect((await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } })).webhookUrl).toBe(
    'https://example.com/hook',
  );
});

/** Run one notice job and return its send step (null when the notice was dropped). */
const runNoticeJob = async (id: string, payload: Record<string, unknown>) => {
  await jobs.triggerJob({ id, name: 'send.solidten.notice.email', payload } as Parameters<typeof jobs.triggerJob>[0]);

  const findJob = async () =>
    await prisma.backgroundJob.findFirst({
      where: { jobId: 'send.solidten.notice.email', payload: { equals: payload } },
      orderBy: { submittedAt: 'desc' },
    });

  await expect.poll(async () => (await findJob())?.status, { timeout: 30_000 }).toBe('COMPLETED');

  const job = await findJob();

  return await prisma.backgroundJobTask.findFirst({
    where: { jobId: job?.id, name: 'send-solidten-notice-email', status: 'COMPLETED' },
  });
};

const seedSignerWithPrivateThread = async () => {
  const { user, team } = await seedUser();
  const signerEmail = uniqueEmail('first-person');

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [signerEmail],
    fields: [],
    updateDocumentOptions: { internalVersion: 2 },
  });

  const [recipient] = recipients;

  const thread = await prisma.envelopeCommentThread.create({
    data: {
      envelopeId: document.id,
      key: getRecipientCommentThreadKey(recipient),
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
    },
  });

  const comment = await prisma.envelopeComment.create({
    data: {
      threadId: thread.id,
      envelopeId: document.id,
      authorType: 'TEAM',
      authorUserId: user.id,
      authorName: user.name ?? '',
      authorEmail: user.email,
      body: 'Private reply for the first person.',
    },
  });

  return { document, recipient, comment };
};

test('[AUD-C8]: a queued team reply is not mailed to the person who took over the link', async () => {
  const { document, recipient, comment } = await seedSignerWithPrivateThread();

  // The link is handed to someone else before the email job runs.
  await prisma.recipient.update({ where: { id: recipient.id }, data: { email: uniqueEmail('second-person') } });

  const sent = await runNoticeJob(`audit-c8-comment-${comment.id}`, {
    kind: 'COMMENT_FROM_TEAM',
    envelopeId: document.id,
    commentId: comment.id,
    recipientId: recipient.id,
  });

  expect(sent).toBeNull();
});

test('[AUD-C8]: a queued team reply still goes to the same person', async () => {
  const { document, recipient, comment } = await seedSignerWithPrivateThread();

  const sent = await runNoticeJob(`audit-c8-comment-same-${comment.id}`, {
    kind: 'COMMENT_FROM_TEAM',
    envelopeId: document.id,
    commentId: comment.id,
    recipientId: recipient.id,
  });

  expect(sent).not.toBeNull();
});

test('[AUD-C8]: a deadline notice written for one person is not mailed to the next', async () => {
  const { document, recipient } = await seedSignerWithPrivateThread();

  // The expiry job records who the notice is for.
  await prisma.recipient.update({ where: { id: recipient.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await jobs.triggerJob({ name: 'internal.process-recipient-expired', payload: { recipientId: recipient.id } });

  await expect
    .poll(
      async () =>
        (
          await prisma.backgroundJob.findFirst({
            where: {
              jobId: 'send.solidten.notice.email',
              AND: [
                { payload: { path: ['kind'], equals: 'SIGNER_DEADLINE_PASSED' } },
                { payload: { path: ['recipientId'], equals: recipient.id } },
              ],
            },
          })
        )?.payload,
      { timeout: 30_000 },
    )
    .toMatchObject({ recipientEmail: recipient.email });

  // A notice queued for the first person, after the link went to someone else.
  await prisma.recipient.update({ where: { id: recipient.id }, data: { email: uniqueEmail('second-person') } });

  const sent = await runNoticeJob(`audit-c8-deadline-${recipient.id}`, {
    kind: 'SIGNER_DEADLINE_PASSED',
    envelopeId: document.id,
    recipientId: recipient.id,
    recipientEmail: recipient.email,
  });

  expect(sent).toBeNull();
});

test('[AUD-C9]: the analytics proxy answers 404 when no analytics key is set', async ({ request }) => {
  test.skip(Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY), 'This instance has an analytics key.');

  const response = await request.post(`${WEBAPP_BASE_URL}/ingest/e/`, {
    headers: { cookie: 'sessionId=not-for-analytics', 'content-type': 'application/json' },
    data: { event: 'probe' },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(404);
});

const signedInContext = async (browser: Browser, email: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await apiSignin({ page, email });

  return { context, page, request: context.request };
};

/** The shape the server accepts; it is checked only after the step-up. */
const DUMMY_REGISTRATION = {
  id: 'audit-c10',
  rawId: 'audit-c10',
  response: { clientDataJSON: 'e30', attestationObject: 'e30' },
  clientExtensionResults: {},
  type: 'public-key',
};

const newestSessionOf = async (userId: number) =>
  await prisma.session.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } });

test('[AUD-C10]: adding a passkey needs a sign-in from the last 10 minutes', async ({ browser }) => {
  const { user } = await seedUser();
  const device = await signedInContext(browser, user.email);

  const session = await newestSessionOf(user.id);
  await prisma.session.update({ where: { id: session.id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });

  const options = await trpcPost(device.request, 'auth.passkey.createRegistrationOptions', undefined);
  expect(options.ok()).toBe(false);
  expect(await options.text()).toContain('sign in again to add a passkey');

  const create = await trpcPost(device.request, 'auth.passkey.create', {
    passkeyName: 'Stale',
    verificationResponse: DUMMY_REGISTRATION,
  });
  expect(create.ok()).toBe(false);
  expect(await create.text()).toContain('sign in again to add a passkey');

  await device.context.close();
});

test('[AUD-C10]: adding a passkey needs a 2FA code when 2FA is on', async ({ browser }) => {
  const { user } = await seedUser();
  const device = await signedInContext(browser, user.email);

  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true, twoFactorSecret: 'unused' } });

  const create = await trpcPost(device.request, 'auth.passkey.create', {
    passkeyName: 'No code',
    verificationResponse: DUMMY_REGISTRATION,
  });
  expect(create.ok()).toBe(false);
  expect(await create.text()).toContain('code from your authenticator app to add a passkey');

  await device.context.close();
});

test("[AUD-C10]: removing a passkey signs out the user's other sessions", async ({ browser }) => {
  const { user } = await seedUser();
  const other = await signedInContext(browser, user.email);
  const device = await signedInContext(browser, user.email);

  const current = await newestSessionOf(user.id);

  const passkey = await prisma.passkey.create({
    data: {
      userId: user.id,
      name: 'Old key',
      credentialId: Buffer.from('audit-c10-credential'),
      credentialPublicKey: Buffer.from('audit-c10-key'),
      counter: 0,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      transports: [],
    },
  });

  const removed = await trpcPost(device.request, 'auth.passkey.delete', { passkeyId: passkey.id });
  expect(removed.ok(), await removed.text()).toBe(true);

  const sessions = await prisma.session.findMany({ where: { userId: user.id } });
  expect(sessions.map((session) => session.id)).toEqual([current.id]);

  await other.context.close();
  await device.context.close();
});

test('[AUD-C11]: on an action-auth document another signed-in account cannot complete for the recipient', async () => {
  const { user: owner, team } = await seedUser();
  const { user: signerUser } = await seedUser();
  const { user: otherUser } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [signerUser],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: {
      internalVersion: 2,
      authOptions: { globalAccessAuth: [], globalActionAuth: ['PASSWORD'] },
    },
  });

  const [recipient] = recipients;

  // The recipient signed every field themselves.
  const field = await prisma.field.findFirstOrThrow({ where: { recipientId: recipient.id } });
  await prisma.field.update({ where: { id: field.id }, data: { inserted: true } });
  await prisma.signature.create({ data: { fieldId: field.id, recipientId: recipient.id, typedSignature: 'Signer' } });

  await expect(
    completeDocumentWithToken({
      token: recipient.token,
      id: { type: 'envelopeId', id: document.id },
      userId: otherUser.id,
    }),
  ).rejects.toThrow('signed in with a different account');

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus).toBe(
    SigningStatus.NOT_SIGNED,
  );

  // The recipient's own account completes as before.
  await completeDocumentWithToken({
    token: recipient.token,
    id: { type: 'envelopeId', id: document.id },
    userId: signerUser.id,
  });

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus).toBe(
    SigningStatus.SIGNED,
  );
});

const API_V2 = `${WEBAPP_BASE_URL}/api/v2-beta`;
const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const createDraftViaApi = async (
  request: APIRequestContext,
  recipients: Array<{ email: string; name: string; role: RecipientRole }>,
  meta?: { signingOrder?: DocumentSigningOrder },
) => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'audit-c12', expiresIn: null });
  const headers = { Authorization: `Bearer ${token}` };

  const formData = new FormData();
  formData.append(
    'payload',
    JSON.stringify({
      type: 'DOCUMENT',
      title: '[TEST] Assistant order',
      meta,
      recipients: recipients.map((recipient) => ({
        ...recipient,
        fields:
          recipient.role === RecipientRole.SIGNER
            ? [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 10, width: 10, height: 5 }]
            : [],
      })),
    }),
  );
  formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

  const response = await request.post(`${API_V2}/envelope/create`, { headers, multipart: formData });

  return { response, headers };
};

test('[AUD-C12]: the server refuses an assistant without sequential signing', async ({ request }) => {
  const signer = { email: uniqueEmail('c12-signer'), name: 'Signer', role: RecipientRole.SIGNER };
  const assistant = { email: uniqueEmail('c12-assistant'), name: 'Assistant', role: RecipientRole.ASSISTANT };

  // Create with an assistant and no signing order.
  const refusedCreate = await createDraftViaApi(request, [assistant, signer]);
  expect(refusedCreate.response.status()).toBe(400);
  expect(await refusedCreate.response.text()).toContain('An assistant needs a signing order');

  // Add an assistant to a parallel draft.
  const draft = await createDraftViaApi(request, [signer]);
  expect(draft.response.ok(), await draft.response.text()).toBe(true);
  const { id: envelopeId } = (await draft.response.json()) as { id: string };

  const added = await request.post(`${API_V2}/envelope/recipient/create-many`, {
    headers: draft.headers,
    data: { envelopeId, data: [{ ...assistant, email: uniqueEmail('c12-added') }] },
  });
  expect(added.status()).toBe(400);
  expect(await added.text()).toContain('An assistant needs a signing order');

  // Turn the signer into an assistant.
  const [existing] = await prisma.recipient.findMany({ where: { envelopeId } });
  const updated = await request.post(`${API_V2}/envelope/recipient/update-many`, {
    headers: draft.headers,
    data: { envelopeId, data: [{ id: existing.id, role: RecipientRole.ASSISTANT }] },
  });
  expect(updated.status()).toBe(400);

  // An assistant written around the checks is refused at send.
  await prisma.recipient.create({
    data: {
      envelopeId,
      email: uniqueEmail('c12-raw'),
      name: 'Raw',
      role: RecipientRole.ASSISTANT,
      token: `c12-${Date.now()}`,
    },
  });
  const sent = await request.post(`${API_V2}/envelope/distribute`, { headers: draft.headers, data: { envelopeId } });
  expect(sent.status()).toBe(400);
  expect(await sent.text()).toContain('An assistant needs a signing order');
  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status).toBe('DRAFT');

  // With sequential signing an assistant is accepted.
  const sequential = await createDraftViaApi(request, [assistant, signer], {
    signingOrder: DocumentSigningOrder.SEQUENTIAL,
  });
  expect(sequential.response.ok(), await sequential.response.text()).toBe(true);
});
