import zlib from 'node:zlib';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  DocumentVisibility,
  EnvelopeType,
  FieldType,
  OrganisationGroupType,
  OrganisationMemberRole,
  TeamMemberRole,
} from '@documenso/prisma/client';
import {
  seedBlankDocument,
  seedPendingDocument,
  seedPendingDocumentWithFullFields,
} from '@documenso/prisma/seed/documents';
import { seedOrganisationMembers } from '@documenso/prisma/seed/organisations';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import type { TCreateEnvelopePayload } from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, apiSignout, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { healthHeaders } from '../fixtures/health';

/**
 * Solid Ten: regression tests for the audit fixes of 11/21 (builder B). Each test names its finding.
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const apiUrl = `${WEBAPP_BASE_URL}/api/v2-beta`;

/**
 * A one-page PDF whose single content stream is `inflatedMib` MiB of "q Q" operators, deflated.
 * At 64 MiB the file is about 65 KB (far below the 2 MiB heavy-PDF size) and reading the page text
 * needs more memory than a 1.5 GB heap holds. Built here so no such file sits in the repository.
 */
const buildPdf = (inflatedMib: number) => {
  const raw = inflatedMib > 0 ? Buffer.alloc(inflatedMib * 1024 * 1024, 'q Q\n') : Buffer.from('q Q\n');
  const content = zlib.deflateSync(raw, { level: 9 });
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (chunk: string | Buffer) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(buffer);
    length += buffer.length;
  };

  const object = (id: number, ...body: Array<string | Buffer>) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    for (const chunk of body) {
      push(chunk);
    }
    push('\nendobj\n');
  };

  push('%PDF-1.7\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>');
  object(4, `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, content, '\nendstream');

  const xref = length;
  push('xref\n0 5\n0000000000 65535 f \n');
  for (const id of [1, 2, 3, 4]) {
    push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return Buffer.concat(parts);
};

const createOwner = async () => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'audit-b', expiresIn: null });

  return { user, team, authHeaders: { Authorization: `Bearer ${token}` } };
};

type Owner = Awaited<ReturnType<typeof createOwner>>;

const createEnvelopeWithPdf = async (
  request: APIRequestContext,
  owner: Owner,
  pdf: Buffer,
  type = EnvelopeType.DOCUMENT,
) => {
  const formData = new FormData();
  formData.append(
    'payload',
    JSON.stringify({ type, title: `[TEST] audit B ${Date.now()}` } satisfies TCreateEnvelopePayload),
  );
  formData.append('files', new File([pdf], 'file.pdf', { type: 'application/pdf' }));

  return await request.post(`${apiUrl}/envelope/create`, {
    headers: owner.authHeaders,
    multipart: formData,
    timeout: 120_000,
  });
};

/** The app still answers: the health route and a small ordinary upload. */
const expectAppAlive = async (request: APIRequestContext, owner: Owner) => {
  const health = await request.get(`${WEBAPP_BASE_URL}/api/health`, { timeout: 30_000, headers: healthHeaders() });
  expect(health.status()).toBe(200);

  const control = await createEnvelopeWithPdf(request, owner, buildPdf(0));
  expect(control.ok(), await control.text()).toBeTruthy();
};

/** The plain "too complex" answer of a PDF child that died. */
const expectTooComplex = async (res: Awaited<ReturnType<APIRequestContext['post']>>) => {
  expect(res.status(), await res.text()).toBe(422);
  expect(await res.text()).toContain('This document is too large or complex to process.');
};

/** Uploads that ran in a PDF child, from the /api/health detail (a local call sees it). */
const getPdfChildRuns = async (request: APIRequestContext) => {
  const res = await request.get(`${WEBAPP_BASE_URL}/api/health`, { timeout: 30_000, headers: healthHeaders() });
  const body = (await res.json()) as { pdfChild?: { runs: number } };

  return body.pdfChild?.runs ?? 0;
};

const createControlEnvelope = async (request: APIRequestContext, owner: Owner) => {
  const res = await createEnvelopeWithPdf(request, owner, buildPdf(0));
  expect(res.ok(), await res.text()).toBeTruthy();
  const { id } = (await res.json()) as { id: string };

  return await prisma.envelope.findUniqueOrThrow({ where: { id }, include: { envelopeItems: true } });
};

/** An organisation member whose only path to the team is a new custom group, and a draft they sent there. */
const seedGroupMember = async (organisationId: string, teamId: number) => {
  const [member] = await seedOrganisationMembers({
    members: [{ organisationRole: OrganisationMemberRole.MEMBER }],
    organisationId,
  });
  const organisationMember = await prisma.organisationMember.findFirstOrThrow({
    where: { userId: member.id, organisationId },
  });
  const groupId = `org_group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await prisma.organisationGroup.create({
    data: {
      id: groupId,
      name: 'Custom',
      type: OrganisationGroupType.CUSTOM,
      organisationRole: OrganisationMemberRole.MEMBER,
      organisationId,
      organisationGroupMembers: { create: { id: `${groupId}_m`, organisationMemberId: organisationMember.id } },
    },
  });
  const teamGroup = await prisma.teamGroup.create({
    data: { id: `${groupId}_t`, organisationGroupId: groupId, teamId, teamRole: TeamMemberRole.MEMBER },
  });
  const envelope = await seedBlankDocument(member, teamId, { internalVersion: 2 });

  return { member, groupId, teamGroupId: teamGroup.id, envelopeId: envelope.id };
};

/** A team that does not let every organisation member in: access comes only from custom groups. */
const seedClosedTeam = async () => {
  const seeded = await seedTeam();
  await prisma.teamGroup.deleteMany({
    where: {
      teamId: seeded.team.id,
      organisationGroup: {
        type: OrganisationGroupType.INTERNAL_ORGANISATION,
        organisationRole: OrganisationMemberRole.MEMBER,
      },
    },
  });

  return seeded;
};

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const findMailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

test.describe('[AUDIT_B] audit fixes, builder B', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test('AUD-2: a small PDF that inflates far beyond its size gets a 422 and the app keeps running', async ({
    request,
  }) => {
    const owner = await createOwner();
    const bomb = buildPdf(64);
    expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024);

    const res = await createEnvelopeWithPdf(request, owner, bomb).catch((error: Error) => error);
    expect(res, 'the app process must not die on the upload').not.toBeInstanceOf(Error);

    if (!(res instanceof Error)) {
      await expectTooComplex(res);
    }

    await expectAppAlive(request, owner);
  });
  test('AUD-5: adding an item with a small inflating PDF gets a 422 and the app keeps running', async ({ request }) => {
    const owner = await createOwner();
    const envelope = await createControlEnvelope(request, owner);

    const formData = new FormData();
    formData.append('payload', JSON.stringify({ envelopeId: envelope.id }));
    formData.append('files', new File([buildPdf(64)], 'added.pdf', { type: 'application/pdf' }));

    const res = await request
      .post(`${apiUrl}/envelope/item/create-many`, {
        headers: owner.authHeaders,
        multipart: formData,
        timeout: 120_000,
      })
      .catch((error: Error) => error);
    expect(res, 'the app process must not die on the upload').not.toBeInstanceOf(Error);

    if (!(res instanceof Error)) {
      await expectTooComplex(res);
    }

    await expectAppAlive(request, owner);
  });

  test('AUD-5: replacing an item PDF with a small inflating PDF gets a 422 and the app keeps running', async ({
    page,
    request,
  }) => {
    const owner = await createOwner();
    const envelope = await createControlEnvelope(request, owner);

    await apiSignin({ page, email: owner.user.email, redirectPath: '/' });

    const formData = new FormData();
    formData.append(
      'payload',
      JSON.stringify({ envelopeId: envelope.id, envelopeItemId: envelope.envelopeItems[0].id }),
    );
    formData.append('file', new File([buildPdf(64)], 'replaced.pdf', { type: 'application/pdf' }));

    const res = await page
      .context()
      .request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.item.replacePdf`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(owner.team.id) },
        multipart: formData,
        timeout: 120_000,
      })
      .catch((error: Error) => error);
    expect(res, 'the app process must not die on the upload').not.toBeInstanceOf(Error);

    if (!(res instanceof Error)) {
      expect(res.status(), await res.text()).toBe(422);
      expect(await res.text()).toContain('This document is too large or complex to process.');
    }

    await expectAppAlive(request, owner);
  });

  test('AUD-5: legacy document create (with form values) and template create parse the file in the PDF child', async ({
    request,
  }) => {
    const owner = await createOwner();

    const documentForm = new FormData();
    documentForm.append('payload', JSON.stringify({ title: '[TEST] legacy create', formValues: { name: 'Ann' } }));
    documentForm.append('file', new File([buildPdf(0)], 'legacy.pdf', { type: 'application/pdf' }));

    const runsBeforeDocument = await getPdfChildRuns(request);
    const documentRes = await request.post(`${apiUrl}/document/create`, {
      headers: owner.authHeaders,
      multipart: documentForm,
    });
    expect(documentRes.ok(), await documentRes.text()).toBeTruthy();
    expect(await getPdfChildRuns(request)).toBeGreaterThan(runsBeforeDocument);

    const templateForm = new FormData();
    templateForm.append('payload', JSON.stringify({ title: '[TEST] template create' }));
    templateForm.append('file', new File([buildPdf(0)], 'template.pdf', { type: 'application/pdf' }));

    const runsBeforeTemplate = await getPdfChildRuns(request);
    const templateRes = await request.post(`${apiUrl}/template/create`, {
      headers: owner.authHeaders,
      multipart: templateForm,
    });
    expect(templateRes.ok(), await templateRes.text()).toBeTruthy();
    expect(await getPdfChildRuns(request)).toBeGreaterThan(runsBeforeTemplate);
  });
  test('AUD-4: a team email gives no access to envelopes the mailbox account sent in another organisation', async ({
    page,
    request,
  }) => {
    // The mailbox account sends a document in its own organisation.
    const mailbox = await seedUser();
    const title = `[TEST] AUD-4 ${Date.now()}`;
    const envelope = await seedBlankDocument(mailbox.user, mailbox.team.id, {
      internalVersion: 2,
      createDocumentOptions: { title },
    });

    // Another organisation's team has the mailbox address as its verified team email.
    const other = await createOwner();
    await prisma.teamEmail.create({ data: { teamId: other.team.id, name: 'Mailbox', email: mailbox.user.email } });

    const getRes = await request.get(`${apiUrl}/envelope/${envelope.id}`, { headers: other.authHeaders });
    expect(getRes.status(), await getRes.text()).toBe(404);

    const findRes = await request.get(`${apiUrl}/envelope?perPage=100`, { headers: other.authHeaders });
    expect(findRes.ok(), await findRes.text()).toBeTruthy();
    expect(await findRes.text()).not.toContain(envelope.id);

    const updateRes = await request.post(`${apiUrl}/envelope/update`, {
      headers: other.authHeaders,
      data: { envelopeId: envelope.id, data: { title: 'renamed by another organisation' } },
    });
    expect(updateRes.ok()).toBeFalsy();

    const deleteRes = await request.post(`${apiUrl}/envelope/delete`, {
      headers: other.authHeaders,
      data: { envelopeId: envelope.id },
    });
    expect(deleteRes.ok()).toBeFalsy();

    const after = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });
    expect(after.title).toBe(title);
    expect(after.deletedAt).toBeNull();

    // The document list and its counts (find-documents and get-stats) do not show it either.
    await apiSignin({ page, email: other.user.email, redirectPath: '/' });
    const input = encodeURIComponent(JSON.stringify({ json: { page: 1, perPage: 100 } }));
    const listRes = await page
      .context()
      .request.get(`${WEBAPP_BASE_URL}/api/trpc/document.findDocumentsInternal?input=${input}`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(other.team.id) },
      });
    const listText = await listRes.text();
    expect(listRes.ok(), listText).toBeTruthy();
    expect(listText).not.toContain(title);
    const list = JSON.parse(listText) as { result: { data: { json: { stats: Record<string, number> } } } };
    expect(list.result.data.json.stats.DRAFT).toBe(0);
  });
  test('AUD-9: an API token reaches only its own team, also for envelopes its user owns elsewhere', async ({
    request,
  }) => {
    // A user who belongs to two teams: their own (team A) and another organisation's team (team B).
    const { team: teamB } = await seedUser();
    const member = await seedTeamMember({ teamId: teamB.id });
    const teamA = await prisma.team.findFirstOrThrow({ where: { organisation: { ownerUserId: member.id } } });

    const title = `[TEST] AUD-9 ${Date.now()}`;
    const envelope = await seedBlankDocument(member, teamA.id, {
      internalVersion: 2,
      createDocumentOptions: { title },
    });
    const documentId = Number(envelope.secondaryId.split('_').pop());

    const tokenFor = async (teamId: number) => {
      const { token } = await createApiToken({ userId: member.id, teamId, tokenName: 'aud-9', expiresIn: null });

      return { Authorization: `Bearer ${token}` };
    };

    // The team A token still reaches the user's own envelope in team A.
    const ownTeam = await request.get(`${apiUrl}/envelope/${envelope.id}`, { headers: await tokenFor(teamA.id) });
    expect(ownTeam.status(), await ownTeam.text()).toBe(200);

    // The team B token does not, on v2 get and update and on v1 get.
    const teamBHeaders = await tokenFor(teamB.id);

    const getRes = await request.get(`${apiUrl}/envelope/${envelope.id}`, { headers: teamBHeaders });
    expect(getRes.status(), await getRes.text()).toBe(404);

    const updateRes = await request.post(`${apiUrl}/envelope/update`, {
      headers: teamBHeaders,
      data: { envelopeId: envelope.id, data: { title: 'renamed through another team' } },
    });
    expect(updateRes.ok()).toBeFalsy();

    const v1Res = await request.get(`${WEBAPP_BASE_URL}/api/v1/documents/${documentId}`, { headers: teamBHeaders });
    expect(v1Res.ok(), await v1Res.text()).toBeFalsy();

    const after = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });
    expect(after.title).toBe(title);
  });
  test("group removal moves the removed member's envelopes to the organisation owner (all three paths)", async ({
    page,
  }) => {
    const { owner, team, organisation } = await seedClosedTeam();

    const viaUpdate = await seedGroupMember(organisation.id, team.id);
    const viaDelete = await seedGroupMember(organisation.id, team.id);
    const viaTeamGroupDelete = await seedGroupMember(organisation.id, team.id);

    await apiSignin({ page, email: owner.email, redirectPath: '/' });
    const call = async (path: string, json: unknown) => {
      const res = await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(team.id) },
        data: JSON.stringify({ json }),
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    };

    await call('organisation.group.update', { id: viaUpdate.groupId, memberIds: [] });
    await call('organisation.group.delete', { organisationId: organisation.id, groupId: viaDelete.groupId });
    await call('team.group.delete', { teamId: team.id, teamGroupId: viaTeamGroupDelete.teamGroupId });

    for (const { envelopeId } of [viaUpdate, viaDelete, viaTeamGroupDelete]) {
      const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
      expect(envelope.userId).toBe(owner.id);
    }
  });
  test('an owner who lost team access gets no "recipient signed" notice', async () => {
    test.skip(!MAIL_SINK_URL, 'needs E2E_MAIL_SINK_URL');

    const { team, organisation } = await seedClosedTeam();
    const { member, groupId } = await seedGroupMember(organisation.id, team.id);
    const signerEmail = `signer-${Date.now()}@auditb.test`;
    const envelope = await seedPendingDocument(member, team.id, [signerEmail], { internalVersion: 2 });
    const [signer] = await prisma.recipient.findMany({ where: { envelopeId: envelope.id } });

    // Access lost without the hand-off (data from before the group fix): the member still owns it.
    await prisma.organisationGroupMember.deleteMany({ where: { groupId } });

    const documentId = Number(envelope.secondaryId.split('_').pop());
    await jobs.triggerJob({ name: 'send.recipient.signed.email', payload: { documentId, recipientId: signer.id } });

    // Let the job run, then check the member's inbox.
    const deadline = Date.now() + 30_000;
    let isDone = false;

    while (!isDone && Date.now() < deadline) {
      const job = await prisma.backgroundJob.findFirst({
        where: { jobId: 'send.recipient.signed.email', payload: { path: ['recipientId'], equals: signer.id } },
      });
      isDone = job?.status === 'COMPLETED' || job?.status === 'FAILED';
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(isDone).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await findMailSubjects(member.email)).toEqual([]);
  });
  test('AUD-7: file routes apply document visibility to a team MEMBER', async ({ page, request }) => {
    const { owner, team } = await seedTeam();
    const member = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MEMBER });

    const seedWithVisibility = async (visibility: DocumentVisibility) => {
      const envelope = await seedBlankDocument(owner, team.id, {
        internalVersion: 2,
        createDocumentOptions: { visibility },
      });
      const [item] = await prisma.envelopeItem.findMany({ where: { envelopeId: envelope.id } });

      return { envelope, item };
    };

    const hidden = await seedWithVisibility(DocumentVisibility.ADMIN);
    const managers = await seedWithVisibility(DocumentVisibility.MANAGER_AND_ABOVE);
    const open = await seedWithVisibility(DocumentVisibility.EVERYONE);

    await apiSignin({ page, email: member.email, redirectPath: '/' });

    const sessionGet = async ({ envelope, item }: Awaited<ReturnType<typeof seedWithVisibility>>, path: string) =>
      await page
        .context()
        .request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/envelopeItem/${item.id}${path}`);

    for (const target of [hidden, managers]) {
      expect((await sessionGet(target, '/download/original')).ok()).toBeFalsy();
      expect((await sessionGet(target, '')).ok()).toBeFalsy();
      expect((await sessionGet(target, `/dataId/${target.item.documentDataId}/initial/item.pdf`)).ok()).toBeFalsy();
    }

    // The member still gets an EVERYONE document.
    const allowed = await sessionGet(open, '/download/original');
    expect(allowed.ok(), await allowed.text()).toBeTruthy();

    // The API item download applies the same rule to a MANAGER's token (a MEMBER cannot make one).
    const manager = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MANAGER });
    const { token } = await createApiToken({
      userId: manager.id,
      teamId: team.id,
      tokenName: 'aud-7',
      expiresIn: null,
    });
    const apiGet = async (itemId: string) =>
      await request.get(`${apiUrl}/envelope/item/${itemId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    expect((await apiGet(hidden.item.id)).ok()).toBeFalsy();
    expect((await apiGet(managers.item.id)).ok()).toBeTruthy();
  });
  test('AUD-13: the qr_ token opens files only of a completed, not deleted document, and no signing page shows it', async ({
    request,
  }) => {
    const { user, team } = await seedUser();
    const envelope = await seedPendingDocument(user, team.id, [`signer-${Date.now()}@auditb.test`], {
      internalVersion: 2,
    });
    // Real envelopes get a qr_ token at creation; the seed helper does not set one.
    const qrToken = `qr_audb${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
    await prisma.envelope.update({ where: { id: envelope.id }, data: { qrToken } });
    const [item] = await prisma.envelopeItem.findMany({ where: { envelopeId: envelope.id } });
    const [recipient] = await prisma.recipient.findMany({ where: { envelopeId: envelope.id } });

    const qrFiles = async () => {
      const base = `${WEBAPP_BASE_URL}/api/files/token/${qrToken}/envelopeItem/${item.id}`;

      return [
        (await request.get(base)).ok(),
        (await request.get(`${base}/download/original`)).ok(),
        (
          await request.get(
            `${WEBAPP_BASE_URL}/api/files/token/${qrToken}/envelope/${envelope.id}/envelopeItem/${item.id}/dataId/${item.documentDataId}/initial/item.pdf`,
          )
        ).ok(),
      ];
    };

    // Pending: the qr_ value opens nothing, and the recipient's pages do not carry it.
    expect(await qrFiles()).toEqual([false, false, false]);

    for (const path of ['', '/complete']) {
      const pageRes = await request.get(`${WEBAPP_BASE_URL}/sign/${recipient.token}${path}`);
      expect(await pageRes.text()).not.toContain(qrToken);
    }

    // Completed: the share link works, as the share page does.
    await prisma.envelope.update({ where: { id: envelope.id }, data: { status: DocumentStatus.COMPLETED } });
    expect((await qrFiles()).slice(0, 2)).toEqual([true, true]);

    // Deleted: it stops again.
    await prisma.envelope.update({ where: { id: envelope.id }, data: { deletedAt: new Date() } });
    expect(await qrFiles()).toEqual([false, false, false]);
  });
  test("AUD-10: a PASSWORD step-up must come from the recipient's own account", async ({ page }) => {
    const { user: sender, team } = await seedUser();
    const { user: carol } = await seedUser();
    const { user: mallory } = await seedUser();

    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: sender,
      teamId: team.id,
      recipients: [carol],
      recipientsCreateOptions: [{ authOptions: { accessAuth: [], actionAuth: ['PASSWORD'] } }],
      fields: [FieldType.SIGNATURE],
      updateDocumentOptions: { internalVersion: 2 },
    });
    const [recipient] = recipients;
    const [field] = await prisma.field.findMany({ where: { recipientId: recipient.id } });

    const sign = async () =>
      await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
        data: JSON.stringify({
          json: {
            token: recipient.token,
            fieldId: field.id,
            fieldValue: { type: 'SIGNATURE', value: 'Carol' },
            authOptions: { type: 'PASSWORD', password: 'password' },
          },
        }),
      });

    // Another account with its own correct password: refused, nothing recorded.
    await apiSignin({ page, email: mallory.email, redirectPath: '/' });
    const forged = await sign();
    expect(forged.ok(), await forged.text()).toBeFalsy();
    expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).inserted).toBe(false);

    // The recipient's own account: accepted.
    await apiSignout({ page });
    await apiSignin({ page, email: carol.email, redirectPath: '/' });
    const own = await sign();
    expect(own.ok(), await own.text()).toBeTruthy();
    expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).inserted).toBe(true);
  });
  test('AUD-2 follow-up: a normalise-only upload of the stress file is refused with a 422, not stored', async ({
    page,
    request,
  }) => {
    const owner = await createOwner();
    const bomb = buildPdf(64);

    const legacyForm = new FormData();
    legacyForm.append('payload', JSON.stringify({ title: '[TEST] stress legacy' }));
    legacyForm.append('file', new File([bomb], 'stress.pdf', { type: 'application/pdf' }));
    const legacy = await request
      .post(`${apiUrl}/document/create`, { headers: owner.authHeaders, multipart: legacyForm, timeout: 120_000 })
      .catch((error: Error) => error);
    expect(legacy, 'the app process must not die on the upload').not.toBeInstanceOf(Error);
    if (!(legacy instanceof Error)) {
      await expectTooComplex(legacy);
    }

    const templateForm = new FormData();
    templateForm.append('payload', JSON.stringify({ title: '[TEST] stress template' }));
    templateForm.append('file', new File([bomb], 'stress.pdf', { type: 'application/pdf' }));
    const template = await request.post(`${apiUrl}/template/create`, {
      headers: owner.authHeaders,
      multipart: templateForm,
      timeout: 120_000,
    });
    await expectTooComplex(template);

    await apiSignin({ page, email: owner.user.email, redirectPath: '/' });
    const uploadForm = new FormData();
    uploadForm.append('file', new File([bomb], 'stress.pdf', { type: 'application/pdf' }));
    const upload = await page.context().request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      headers: WEBAPP_ORIGIN_HEADERS,
      multipart: uploadForm,
      timeout: 120_000,
    });
    await expectTooComplex(upload);

    // The refused document and template were not created.
    const created = await prisma.envelope.count({
      where: { teamId: owner.team.id, title: { in: ['[TEST] stress legacy', '[TEST] stress template'] } },
    });
    expect(created).toBe(0);

    await expectAppAlive(request, owner);
  });
  test('AUD-2 follow-up: a placeholder field on an already stored stress file gets a 4xx and the app keeps running', async ({
    request,
  }) => {
    const owner = await createOwner();

    // A file stored before ingest refused such files: written straight into the database.
    const envelope = await seedBlankDocument(owner.user, owner.team.id, { internalVersion: 2 });
    const [item] = await prisma.envelopeItem.findMany({ where: { envelopeId: envelope.id } });
    await prisma.documentData.update({
      where: { id: item.documentDataId },
      data: { data: buildPdf(64).toString('base64') },
    });
    const recipient = await prisma.recipient.create({
      data: {
        envelopeId: envelope.id,
        email: `stored-${Date.now()}@auditb.test`,
        name: 'Stored',
        token: `tok_auditb_${Date.now()}`,
        role: 'SIGNER',
      },
    });

    const res = await request
      .post(`${apiUrl}/envelope/field/create-many`, {
        headers: owner.authHeaders,
        data: {
          envelopeId: envelope.id,
          data: [
            { recipientId: recipient.id, type: 'SIGNATURE', placeholder: 'ANYTHING', fieldMeta: { type: 'signature' } },
          ],
        },
        timeout: 120_000,
      })
      .catch((error: Error) => error);
    expect(res, 'the app process must not die on the field').not.toBeInstanceOf(Error);

    if (!(res instanceof Error)) {
      await expectTooComplex(res);
    }

    await expectAppAlive(request, owner);
  });
});
