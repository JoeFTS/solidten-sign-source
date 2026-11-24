import { createHash } from 'node:crypto';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { sweepOrphanFieldFileContents } from '@documenso/lib/server-only/field-file/sweep-orphan-field-file-contents';
import { applyRetentionToEnvelope } from '@documenso/lib/server-only/retention/apply-retention';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { getEnvelopeItemPdfUrl } from '@documenso/lib/utils/envelope-download';
import { createPublicFormOpenedToken, generatePublicFormCode } from '@documenso/lib/utils/public-form';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import type { TGetEnvelopeResponse } from '@documenso/trpc/server/envelope-router/get-envelope.types';
import { PDF } from '@libpdf/core';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { apiSeedPendingDocument, apiSeedTemplate } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { getCanvasBox, getPageCanvas } from '../fixtures/contents';
import { getKonvaFieldTextForPage } from '../fixtures/konva';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const API_BASE_URL = `${WEBAPP_BASE_URL}/api/v2-beta`;

test.describe.configure({ mode: 'parallel' });

type TestFile = { name: string; mimeType: string; buffer: Buffer };

const pdfFile = (name = 'proof-of-address.pdf', body = 'Proof of address'): TestFile => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from(`%PDF-1.4\n% ${body} ${Math.random()}\n%%EOF\n`),
});

const pngFile = (name = 'passport.png'): TestFile => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`not really pixels ${Math.random()}`),
  ]),
});

const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

const SIGNATURE_FIELD = { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 };

const fileField = (fieldMeta: Record<string, unknown> = {}, positionY = 30) => ({
  type: FieldType.FILE,
  page: 1,
  positionX: 5,
  positionY,
  width: 40,
  height: 6,
  fieldMeta: { type: 'file', label: 'Proof of address', ...fieldMeta },
});

test.describe('Solid Ten signer file upload', () => {
  test('a required file blocks completion, and the signer can upload, replace and remove it', async ({
    page,
    request,
  }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'file-ui@test.documenso.com', name: 'File Signer' }],
      fieldsPerRecipient: [[SIGNATURE_FIELD, fileField({ required: true, maxFiles: 2 })]],
    });

    const token = distributeResult.recipients[0].token;
    const field = findFieldByType(envelope, FieldType.FILE);

    // The signature alone is not enough: the server refuses completion.
    await expectOk(signField(page, token, findFieldByType(envelope, FieldType.SIGNATURE).id, 'File Signer'));

    await expect(completeDocumentWithToken({ token, id: { type: 'envelopeId', id: envelope.id } })).rejects.toThrow();

    await openSigningPage(page, token);

    await expect(page.getByText('1 Field Remaining').first()).toBeVisible();
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, field.id)).toBe('Proof of address');

    const first = pdfFile();
    const second = pngFile();
    const third = pdfFile('bank-statement.pdf', 'Bank statement');

    const dialog = page.getByTestId('sign-field-file-dialog');

    await clickField(page, field);
    await expect(dialog).toBeVisible();

    await chooseFile(page, dialog.getByRole('button', { name: 'Choose file' }), first);
    await expect(dialog.getByTestId('sign-field-file-item')).toHaveCount(1);
    await expect(dialog.getByText(first.name)).toBeVisible();

    // Replace the file.
    await chooseFile(page, dialog.getByRole('button', { name: 'Replace' }), second);
    await expect(dialog.getByText(second.name)).toBeVisible();
    await expect(dialog.getByText(first.name)).toHaveCount(0);

    // Remove it, then attach a new one.
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog.getByTestId('sign-field-file-item')).toHaveCount(0);

    await chooseFile(page, dialog.getByRole('button', { name: 'Choose file' }), third);
    await expect(dialog.getByText(third.name)).toBeVisible();

    await dialog.getByRole('button', { name: 'Done' }).click();

    await expect.poll(() => getKonvaFieldTextForPage(page, 1, field.id)).toBe(third.name);
    await expect(page.getByText('0 Fields Remaining').first()).toBeVisible();

    const uploads = await prisma.fieldFileUpload.findMany({ where: { envelopeId: envelope.id } });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      fileName: third.name,
      mimeType: 'application/pdf',
      size: third.buffer.byteLength,
      sha256: sha256(third.buffer),
      uploaderEmail: 'file-ui@test.documenso.com',
    });

    const storedField = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    expect(storedField).toMatchObject({ inserted: true, customText: third.name });

    const logs = await prisma.documentAuditLog.findMany({
      where: {
        envelopeId: envelope.id,
        type: {
          in: [
            DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_UPLOADED,
            DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REPLACED,
            DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REMOVED,
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    expect(logs.map((log) => log.type)).toEqual([
      DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_UPLOADED,
      DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REPLACED,
      DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REMOVED,
      DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_UPLOADED,
    ]);
    expect(logs[0].data).toMatchObject({ fileName: first.name, sha256: sha256(first.buffer) });
    expect(logs[1].data).toMatchObject({
      fileName: second.name,
      sha256: sha256(second.buffer),
      previousFileName: first.name,
      previousSha256: sha256(first.buffer),
    });
    expect(logs[2].data).toMatchObject({ fileName: second.name, reason: 'SIGNER' });
    expect(logs[3].data).toMatchObject({ fileName: third.name, size: third.buffer.byteLength });

    // The IP comes from the proxy headers, which this local run does not set; the
    // certificate test sends one and checks it.
    for (const log of logs) {
      expect(log.email).toBe('file-ui@test.documenso.com');
      expect(log.userAgent).toBeTruthy();
    }

    // Replaced and removed files are gone from storage, not only unlinked.
    const fileContents = await prisma.dataContent.findMany({
      where: { metadata: { path: ['type'], equals: 'file' }, fieldFileUpload: { envelopeId: envelope.id } },
    });

    expect(fileContents).toHaveLength(1);

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByRole('button', { name: 'Sign' }).click();
    await page.waitForURL(`/sign/${token}/complete`);

    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    expect(recipient.signingStatus).toBe(SigningStatus.SIGNED);

    // Files freeze once the signer has completed.
    const late = await uploadFile(page.context().request, { token, fieldId: field.id, file: pdfFile('late.pdf') });

    expect(late.status()).toBe(400);
    expect(await late.text()).toMatch(/already completed|no longer open for signing/);

    const lateRemove = await removeFile(page.context().request, { token, fieldId: field.id, fileId: uploads[0].id });

    expect(lateRemove.ok()).toBe(false);
    expect(await prisma.fieldFileUpload.count({ where: { envelopeId: envelope.id } })).toBe(1);
  });

  test('the server refuses wrong types, disguised files, oversize files and one file too many', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'file-refuse@test.documenso.com', name: 'Refused Signer' }],
      fieldsPerRecipient: [
        [
          SIGNATURE_FIELD,
          fileField({ label: 'PDF only', allowedFileTypes: ['pdf'] }),
          fileField({ label: 'Anything' }, 45),
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const pdfOnly = findField(envelope, 'PDF only');
    const anything = findField(envelope, 'Anything');

    const refused: { field: number; file: TestFile; status: number; message: string }[] = [
      // Allowed in general, but not by this field.
      { field: pdfOnly.id, file: pngFile(), status: 400, message: 'not allowed' },
      // A Windows executable named as a PDF.
      {
        field: anything.id,
        file: { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ\x90\x00\x03\x00\x00\x00') },
        status: 400,
        message: 'not allowed',
      },
      // HTML and SVG named as text.
      {
        field: anything.id,
        file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('<html><script>alert(1)</script>') },
        status: 400,
        message: 'not allowed',
      },
      {
        field: anything.id,
        file: {
          name: 'logo.png',
          mimeType: 'image/png',
          buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        },
        status: 400,
        message: 'not allowed',
      },
      // A plain ZIP archive named as a Word file.
      {
        field: anything.id,
        file: {
          name: 'contract.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer: Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]),
        },
        status: 400,
        message: 'not allowed',
      },
      // An empty file.
      {
        field: anything.id,
        file: { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
        status: 400,
        message: 'The file is empty.',
      },
    ];

    for (const attempt of refused) {
      const response = await uploadFile(request, { token, fieldId: attempt.field, file: attempt.file });

      expect(response.status(), attempt.file.name).toBe(attempt.status);
      expect(await response.text(), attempt.file.name).toContain(attempt.message);
    }

    const bigFile = (size: number): TestFile => ({
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size - 9, 0x20)]),
    });

    // One byte over the 10 MB default: refused by the size check.
    const oversize = await uploadFile(request, { token, fieldId: anything.id, file: bigFile(10 * 1024 * 1024 + 1) });

    expect(oversize.status()).toBe(400);
    expect(await oversize.text()).toContain('larger than 10 MB');

    // Far over: the body limit stops it before tRPC reads it into memory.
    const farOver = await uploadFile(request, { token, fieldId: anything.id, file: bigFile(11 * 1024 * 1024) });

    expect(farOver.status()).toBe(413);

    expect(await prisma.fieldFileUpload.count({ where: { envelopeId: envelope.id } })).toBe(0);

    // One file allowed by default: the second is refused.
    await expectOk(uploadFile(request, { token, fieldId: anything.id, file: pdfFile() }));

    const second = await uploadFile(request, { token, fieldId: anything.id, file: pdfFile('second.pdf') });

    expect(second.status()).toBe(400);
    expect(await second.text()).toContain('takes one file');

    // A signature field does not take files.
    const wrongField = await uploadFile(request, {
      token,
      fieldId: findFieldByType(envelope, FieldType.SIGNATURE).id,
      file: pdfFile(),
    });

    expect(wrongField.ok()).toBe(false);

    // A file field cannot be signed through the normal field route.
    const signed = await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify({ json: { token, fieldId: pdfOnly.id, fieldValue: { type: 'FILE', value: 'x.pdf' } } }),
    });

    expect(signed.ok()).toBe(false);

    const uploads = await prisma.fieldFileUpload.findMany({ where: { envelopeId: envelope.id } });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].fieldId).toBe(anything.id);
  });

  test('only the uploader, recipients of a shared field, and the team can download a file', async ({
    page,
    request,
  }) => {
    const { envelope, distributeResult, user } = await apiSeedPendingDocument(request, {
      recipients: [
        { email: 'file-owner@test.documenso.com', name: 'Owner Signer' },
        { email: 'file-other@test.documenso.com', name: 'Other Signer' },
      ],
      fieldsPerRecipient: [
        [SIGNATURE_FIELD, fileField({ label: 'Private file' })],
        [{ ...SIGNATURE_FIELD, positionX: 50 }, fileField({ label: 'Shared file', visibleToAllRecipients: true }, 60)],
      ],
    });

    const tokenFor = (email: string) => {
      const recipient = distributeResult.recipients.find((candidate) => candidate.email === email);

      if (!recipient) {
        throw new Error(`Recipient ${email} not found`);
      }

      return recipient.token;
    };

    const ownerToken = tokenFor('file-owner@test.documenso.com');
    const otherToken = tokenFor('file-other@test.documenso.com');

    const privateFile = pdfFile('private.pdf');
    const sharedFile = pdfFile('shared.pdf');

    const privateUpload = await readTrpc<{ file: { id: string } }>(
      await expectOk(
        uploadFile(request, { token: ownerToken, fieldId: findField(envelope, 'Private file').id, file: privateFile }),
      ),
    );

    const sharedUpload = await readTrpc<{ file: { id: string } }>(
      await expectOk(
        uploadFile(request, { token: otherToken, fieldId: findField(envelope, 'Shared file').id, file: sharedFile }),
      ),
    );

    const privateId = privateUpload.file.id;
    const sharedId = sharedUpload.file.id;

    // The uploader gets their file, as an attachment with the stored type.
    const own = await request.get(`${WEBAPP_BASE_URL}/api/files/token/${ownerToken}/field-file/${privateId}`);

    expect(own.status()).toBe(200);
    expect(own.headers()['content-type']).toBe('application/pdf');
    expect(own.headers()['content-disposition']).toContain('attachment');
    expect(own.headers()['content-disposition']).toContain('private.pdf');
    expect(own.headers()['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(await own.body()).equals(privateFile.buffer)).toBe(true);

    // Another recipient's token cannot download it.
    const other = await request.get(`${WEBAPP_BASE_URL}/api/files/token/${otherToken}/field-file/${privateId}`);

    expect(other.status()).toBe(404);

    // A field marked visible to all recipients can be read by the other recipient.
    const shared = await request.get(`${WEBAPP_BASE_URL}/api/files/token/${ownerToken}/field-file/${sharedId}`);

    expect(shared.status()).toBe(200);
    expect(Buffer.from(await shared.body()).equals(sharedFile.buffer)).toBe(true);

    // Nobody else's token works, and the listing for a token hides what it may not see.
    const unknown = await request.get(`${WEBAPP_BASE_URL}/api/files/token/not-a-token/field-file/${privateId}`);

    expect(unknown.status()).toBe(404);

    const otherList = await readTrpc<{ files: { id: string }[] }>(
      await request.get(
        `${WEBAPP_BASE_URL}/api/trpc/fieldFile.listForSigner?input=${encodeURIComponent(JSON.stringify({ json: { token: otherToken } }))}`,
      ),
    );

    expect(otherList.files.map((file) => file.id)).toEqual([sharedId]);

    // The other recipient cannot remove the owner's file either.
    const tamper = await removeFile(request, {
      token: otherToken,
      fieldId: findField(envelope, 'Private file').id,
      fileId: privateId,
    });

    expect(tamper.ok()).toBe(false);

    // The sender downloads through the normal document permissions.
    await apiSignin({ page, email: user.email });

    const sender = await page
      .context()
      .request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/field-file/${privateId}`);

    expect(sender.status()).toBe(200);
    expect(Buffer.from(await sender.body()).equals(privateFile.buffer)).toBe(true);

    await page.goto(
      `/t/${await getTeamUrl(envelope.teamId)}/documents/${mapSecondaryIdToDocumentId(envelope.secondaryId)}`,
    );
    await expect(page.getByTestId('document-attached-files')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('document-attached-files').getByText('private.pdf')).toBeVisible();

    // A user outside the team gets nothing.
    const { user: stranger } = await seedUser();

    await page.context().clearCookies();
    await apiSignin({ page, email: stranger.email });

    const strangerResponse = await page
      .context()
      .request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/field-file/${privateId}`);

    expect(strangerResponse.status()).toBe(404);
  });

  test('[S-H4] every download is audited on both routes, and a deleted document serves nothing', async ({
    page,
    request,
  }) => {
    const { envelope, distributeResult, user } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'file-audit@test.documenso.com', name: 'Audit Signer' }],
      fieldsPerRecipient: [[SIGNATURE_FIELD, fileField({ label: 'Audited file' })]],
    });

    const token = distributeResult.recipients[0].token;
    const file = pdfFile('audited.pdf');

    const uploaded = await readTrpc<{ file: { id: string } }>(
      await expectOk(uploadFile(request, { token, fieldId: findField(envelope, 'Audited file').id, file })),
    );
    const fileId = uploaded.file.id;

    const downloads = async () =>
      await prisma.documentAuditLog.findMany({
        where: { envelopeId: envelope.id, type: 'FIELD_FILE_DOWNLOADED' },
        orderBy: { createdAt: 'asc' },
      });

    // The signer's link.
    const bySigner = await request.get(`${WEBAPP_BASE_URL}/api/files/token/${token}/field-file/${fileId}`, {
      headers: { 'x-forwarded-for': '203.0.113.21', 'user-agent': 'SignerAgent/1.0' },
    });
    expect(bySigner.status()).toBe(200);

    // A team member's sign-in.
    await apiSignin({ page, email: user.email });

    const byTeam = await page
      .context()
      .request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/field-file/${fileId}`, {
        headers: { 'x-forwarded-for': '203.0.113.22', 'user-agent': 'TeamAgent/1.0' },
      });
    expect(byTeam.status()).toBe(200);

    const logs = await downloads();
    expect(logs).toHaveLength(2);

    const recipientId = distributeResult.recipients[0].id;

    expect(logs[0]).toMatchObject({
      email: 'file-audit@test.documenso.com',
      ipAddress: '203.0.113.21',
      userAgent: 'SignerAgent/1.0',
    });
    expect(logs[0].data).toMatchObject({
      fileId,
      via: 'RECIPIENT',
      downloadedByRecipientId: recipientId,
      authSessionId: null,
    });

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(logs[1]).toMatchObject({ userId: user.id, ipAddress: '203.0.113.22', userAgent: 'TeamAgent/1.0' });
    expect(logs[1].data).toMatchObject({
      fileId,
      via: 'TEAM',
      authSessionId: session.id,
      downloadedByRecipientId: null,
    });

    // A deleted document no longer serves the file on the team route.
    await prisma.envelope.update({ where: { id: envelope.id }, data: { deletedAt: new Date() } });

    const afterDelete = await page
      .context()
      .request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/field-file/${fileId}`);
    expect(afterDelete.status()).toBe(404);
    expect(await downloads()).toHaveLength(2);
  });

  test('[S-M5] deleting an envelope, a recipient or a field removes the stored file, and a sweep removes leftovers', async ({
    request,
  }) => {
    const seedWithUpload = async (label: string) => {
      const seeded = await apiSeedPendingDocument(request, {
        recipients: [
          { email: `file-del-${label}-a@test.documenso.com`, name: 'First Signer' },
          { email: `file-del-${label}-b@test.documenso.com`, name: 'Second Signer' },
        ],
        fieldsPerRecipient: [
          [SIGNATURE_FIELD, fileField({ label: 'First file' })],
          [{ ...SIGNATURE_FIELD, positionX: 50 }, fileField({ label: 'Second file' }, 60)],
        ],
      });

      const signer = seeded.distributeResult.recipients.find((r) => r.email.includes(`${label}-a`));

      if (!signer) {
        throw new Error('Signer not found');
      }

      const uploaded = await readTrpc<{ file: { id: string } }>(
        await expectOk(
          uploadFile(request, {
            token: signer.token,
            fieldId: findField(seeded.envelope, 'First file').id,
            file: pngFile(),
          }),
        ),
      );

      const upload = await prisma.fieldFileUpload.findUniqueOrThrow({ where: { id: uploaded.file.id } });

      return { ...seeded, signer, upload };
    };

    const contentExists = async (dataContentId: string) =>
      (await prisma.dataContent.count({ where: { id: dataContentId } })) === 1;

    const v2 = async (path: string, token: string, data: Record<string, unknown>) =>
      await expectOk(request.post(`${API_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, data }));

    // The whole envelope.
    const byEnvelope = await seedWithUpload('envelope');
    expect(await contentExists(byEnvelope.upload.dataContentId)).toBe(true);
    await v2('/envelope/delete', byEnvelope.token, { envelopeId: byEnvelope.envelope.id });
    expect(await contentExists(byEnvelope.upload.dataContentId)).toBe(false);

    // The recipient who uploaded. The API refuses this once they acted, so delete the row
    // the way an admin path or a cascade does: the cleanup sits under every delete path.
    const byRecipient = await seedWithUpload('recipient');
    await prisma.recipient.delete({ where: { id: byRecipient.signer.id } });
    expect(await prisma.fieldFileUpload.count({ where: { id: byRecipient.upload.id } })).toBe(0);
    expect(await contentExists(byRecipient.upload.dataContentId)).toBe(false);

    // The field the file was attached to (the API refuses this too once the signer acted).
    const byField = await seedWithUpload('field');
    await prisma.field.delete({ where: { id: byField.upload.fieldId } });
    expect(await contentExists(byField.upload.dataContentId)).toBe(false);

    // Leftover content nothing references is removed by the daily sweep; a dry run keeps it.
    const orphan = await prisma.dataContent.create({
      data: {
        id: `orphan_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        type: 'BYTES_64',
        data: Buffer.from('left behind').toString('base64'),
        metadata: { type: 'file', fileName: 'left.pdf', mimeType: 'application/pdf', fileSize: 11 },
      },
    });

    await sweepOrphanFieldFileContents({ dryRun: true });
    expect(await contentExists(orphan.id)).toBe(true);

    await expect
      .poll(async () => {
        await sweepOrphanFieldFileContents({ dryRun: false });

        return await contentExists(orphan.id);
      })
      .toBe(false);
  });

  test('the certificate lists the file with its hash and the field shows its name', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'file-cert@test.documenso.com', name: 'Certificate Signer' }],
      fieldsPerRecipient: [[SIGNATURE_FIELD, fileField({ label: 'Tax return', required: true })]],
    });

    const token = distributeResult.recipients[0].token;
    const file = pdfFile('tax-return-2025.pdf');

    await expectOk(
      uploadFile(request, {
        token,
        fieldId: findField(envelope, 'Tax return').id,
        file,
        headers: { 'X-Forwarded-For': '203.0.113.7' },
      }),
    );

    const uploadLog = await prisma.documentAuditLog.findFirstOrThrow({
      where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_UPLOADED },
    });

    expect(uploadLog.ipAddress).toBe('203.0.113.7');
    await expectOk(
      request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
        data: JSON.stringify({
          json: {
            token,
            fieldId: findFieldByType(envelope, FieldType.SIGNATURE).id,
            fieldValue: { type: FieldType.SIGNATURE, value: 'Certificate Signer' },
          },
        }),
      }),
    );

    await completeDocumentWithToken({ token, id: { type: 'envelopeId', id: envelope.id } });

    await expect(async () => {
      const sealed = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

      expect(sealed.status).toBe(DocumentStatus.COMPLETED);
    }).toPass({ timeout: 60_000 });

    const completed = await prisma.envelope.findUniqueOrThrow({
      where: { id: envelope.id },
      include: { envelopeItems: { include: { documentData: true } } },
    });

    const signedPdfUrl = getEnvelopeItemPdfUrl({
      type: 'download',
      envelopeItem: completed.envelopeItems[0],
      token,
      version: 'signed',
    });

    const signedPdf = await PDF.load(new Uint8Array(await (await request.get(signedPdfUrl)).body()));
    const pageTexts = signedPdf.extractText().map(readTextByPosition);
    const allText = pageTexts.join('\n');

    // The file is listed with its name, size and SHA-256.
    const hash = sha256(file.buffer);

    expect(allText).toContain('AttachedFiles');
    expect(allText).toContain(file.name);
    expect(allText).toContain(hash);
    expect(allText).toContain(`${file.buffer.byteLength}bytes`);
    expect(allText).toContain('file-cert@test.documenso.com');
    expect(allText).toContain('203.0.113.7');

    // The field on the document page shows the file name; the file itself is not embedded.
    expect(pageTexts[0]).toContain(file.name);
    expect(Buffer.from(await signedPdf.save()).includes(file.buffer)).toBe(false);
  });

  test('a file field hidden by its condition loses its files', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'file-condition@test.documenso.com', name: 'Condition Signer' }],
      fieldsPerRecipient: [
        [
          SIGNATURE_FIELD,
          {
            type: FieldType.CHECKBOX,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 20,
            height: 5,
            fieldMeta: { type: 'checkbox', fieldKey: 'hasProof', values: [{ id: 1, checked: false, value: 'Yes' }] },
          },
          fileField({ label: 'Proof', condition: { fieldKey: 'hasProof', operator: 'checked' } }, 40),
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const checkbox = findFieldByType(envelope, FieldType.CHECKBOX);
    const proof = findField(envelope, 'Proof');

    // Hidden: the upload is refused.
    const hidden = await uploadFile(request, { token, fieldId: proof.id, file: pdfFile() });

    expect(hidden.ok()).toBe(false);
    // N-3: the plain text names the field (was "... hidden because its condition is not met").
    expect(await hidden.text()).toContain('is hidden by an answer you gave, so it cannot be filled in.');

    await expectOk(signFieldWithRequest(request, token, checkbox.id, { type: FieldType.CHECKBOX, value: [0] }));
    await expectOk(uploadFile(request, { token, fieldId: proof.id, file: pdfFile() }));

    expect(await prisma.fieldFileUpload.count({ where: { fieldId: proof.id } })).toBe(1);

    await expectOk(signFieldWithRequest(request, token, checkbox.id, { type: FieldType.CHECKBOX, value: [] }));

    expect(await prisma.fieldFileUpload.count({ where: { fieldId: proof.id } })).toBe(0);
    expect(await prisma.field.findUniqueOrThrow({ where: { id: proof.id } })).toMatchObject({
      inserted: false,
      customText: '',
    });

    const removed = await prisma.documentAuditLog.findFirstOrThrow({
      where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REMOVED },
    });

    expect(removed.data).toMatchObject({ reason: 'CONDITION' });
  });

  test('a retention purge deletes the attached files', async ({ request }) => {
    const { envelope, distributeResult, team } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'file-retention@test.documenso.com', name: 'Retention Signer' }],
      fieldsPerRecipient: [[SIGNATURE_FIELD, fileField()]],
    });

    const token = distributeResult.recipients[0].token;

    await expectOk(
      uploadFile(request, { token, fieldId: findFieldByType(envelope, FieldType.FILE).id, file: pdfFile() }),
    );

    const upload = await prisma.fieldFileUpload.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    const now = new Date();

    // Stand in for a document that was completed long ago.
    await prisma.envelope.update({
      where: { id: envelope.id },
      data: { status: DocumentStatus.COMPLETED, completedAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000) },
    });

    const teamRow = await prisma.team.findUniqueOrThrow({ where: { id: team.id } });

    await prisma.teamGlobalSettings.update({
      where: { id: teamRow.teamGlobalSettingsId },
      data: {
        retentionSettings: {
          enabled: true,
          action: 'PURGE',
          days: 30,
          includeRejected: false,
          includeCancelled: false,
        },
      },
    });

    // A purge runs only 7 days after the last recorded rule change (S-M3).
    await prisma.stSettingsAuditLog.create({
      data: {
        organisationId: teamRow.organisationId,
        teamId: team.id,
        setting: 'retentionSettings',
        userEmail: 'seed@test.documenso.com',
        createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      },
    });

    const outcome = await applyRetentionToEnvelope({ envelopeId: envelope.id, now, dryRun: false });

    expect(outcome.result).toBe('PURGED');
    expect(await prisma.fieldFileUpload.count({ where: { id: upload.id } })).toBe(0);
    expect(await prisma.dataContent.count({ where: { id: upload.dataContentId } })).toBe(0);
  });

  test('templates with a file field cannot get a direct link or public form', async ({ request }) => {
    const { envelope, token } = await apiSeedTemplate(request, {
      recipients: [{ email: 'file-direct@test.documenso.com', name: 'Direct Signer' }],
      fieldsPerRecipient: [[SIGNATURE_FIELD, fileField()]],
    });

    const response = await createDirectLink(request, token, envelope);

    expect(response.ok()).toBe(false);
    expect(await response.text()).toContain('Attach a file');
    expect(await prisma.templateDirectLink.count({ where: { envelopeId: envelope.id } })).toBe(0);
    expect(await prisma.stPublicForm.count({ where: { directLink: { envelopeId: envelope.id } } })).toBe(0);
  });

  test('a template with a public form refuses file fields, and the form refuses one that slipped in', async ({
    page,
    request,
  }) => {
    const { envelope, token, user, team } = await apiSeedTemplate(request, {
      recipients: [{ email: 'file-form@test.documenso.com', name: 'Form Signer' }],
      fieldsPerRecipient: [[SIGNATURE_FIELD]],
    });

    await expectOk(createDirectLink(request, token, envelope));

    const directLink = await prisma.templateDirectLink.findFirstOrThrow({ where: { envelopeId: envelope.id } });
    const form = await prisma.stPublicForm.findUniqueOrThrow({ where: { directLinkId: directLink.id } });

    // Adding a file field to the template is refused.
    const added = await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        envelopeId: envelope.id,
        data: [
          {
            ...fileField(),
            recipientId: directLink.directTemplateRecipientId,
            envelopeItemId: envelope.envelopeItems[0].id,
          },
        ],
      },
    });

    expect(added.ok()).toBe(false);
    expect(await added.text()).toContain('direct link or public form');
    expect(await prisma.field.count({ where: { envelopeId: envelope.id, type: FieldType.FILE } })).toBe(0);

    // A file field written past the checks (for example by an older version) is still
    // refused: by the form settings and, on the server, by the submit path.
    const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    await prisma.field.create({
      data: {
        envelopeId: envelope.id,
        envelopeItemId: envelopeItem.id,
        recipientId: directLink.directTemplateRecipientId,
        type: FieldType.FILE,
        page: 1,
        positionX: 5,
        positionY: 40,
        width: 30,
        height: 5,
        customText: '',
        inserted: false,
        fieldMeta: { type: 'file', label: 'Slipped in' },
      },
    });

    await apiSignin({ page, email: user.email });

    const settings = await postTrpc(
      page.context().request,
      'publicForm.updateSettings',
      {
        envelopeId: envelope.id,
        data: {
          opensAt: null,
          closesAt: null,
          maxSubmissions: null,
          introText: null,
          thankYouMessage: null,
          redirectUrl: null,
          requireVerifiedEmail: true,
        },
      },
      { 'x-team-id': String(team.id) },
    );

    expect(settings.ok()).toBe(false);
    expect(await settings.text()).toContain('Attach a file');

    // Verify the visitor's email so the file check is what stops the submission.
    const visitorEmail = 'file-form-visitor@test.documenso.com';
    const encryptionKey = process.env.NEXT_PRIVATE_ENCRYPTION_KEY ?? '';

    const verified = await postTrpc(
      request,
      'publicForm.verifyCode',
      {
        token: directLink.token,
        email: visitorEmail,
        code: await generatePublicFormCode({
          key: encryptionKey,
          formId: form.id,
          email: visitorEmail,
          now: new Date(),
        }),
      },
      { 'x-forwarded-for': '198.51.100.77' },
    );

    expect(verified.ok(), await verified.text()).toBe(true);

    const { proof } = (await readTrpc<{ proof: string }>(verified)) ?? {};

    const signatureFieldId = (
      await prisma.field.findFirstOrThrow({ where: { envelopeId: envelope.id, type: FieldType.SIGNATURE } })
    ).id;

    const { updatedAt } = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

    const submitted = await postTrpc(
      request,
      'template.createDocumentFromDirectTemplate',
      {
        json: {
          directTemplateToken: directLink.token,
          directRecipientEmail: visitorEmail,
          directRecipientName: 'Form Visitor',
          templateUpdatedAt: updatedAt.toISOString(),
          signedFieldValues: [{ fieldId: signatureFieldId, value: 'Form Visitor', token: '', isBase64: false }],
          publicForm: {
            verifiedProof: proof,
            openedToken: createPublicFormOpenedToken({
              key: encryptionKey,
              formId: form.id,
              now: new Date(Date.now() - 10_000),
            }),
            honeypot: '',
          },
        },
        meta: { values: { templateUpdatedAt: ['Date'] } },
      },
      { 'x-forwarded-for': '198.51.100.77' },
      true,
    );

    expect(submitted.ok()).toBe(false);
    expect(await submitted.text()).toContain('Attach a file');
    expect(
      await prisma.envelope.count({ where: { templateId: mapSecondaryIdToTemplateId(envelope.secondaryId) } }),
    ).toBe(0);
  });
});

type EnvelopeField = TGetEnvelopeResponse['fields'][number];

const findField = (envelope: TGetEnvelopeResponse, label: string) => {
  const field = envelope.fields.find(
    (candidate) => (candidate.fieldMeta as { label?: string } | null)?.label === label,
  );

  if (!field) {
    throw new Error(`Field ${label} not found`);
  }

  return field;
};

const findFieldByType = (envelope: TGetEnvelopeResponse, type: FieldType) => {
  const field = envelope.fields.find((candidate) => candidate.type === type);

  if (!field) {
    throw new Error(`Field of type ${type} not found`);
  }

  return field;
};

const getTeamUrl = async (teamId: number) => (await prisma.team.findUniqueOrThrow({ where: { id: teamId } })).url;

const uploadFile = async (
  request: APIRequestContext,
  {
    token,
    fieldId,
    file,
    replaceFileId,
    headers,
  }: { token: string; fieldId: number; file: TestFile; replaceFileId?: string; headers?: Record<string, string> },
) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/fieldFile.upload`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, ...headers },
    multipart: {
      payload: JSON.stringify({ token, fieldId, replaceFileId }),
      file,
    },
  });

const removeFile = async (
  request: APIRequestContext,
  { token, fieldId, fileId }: { token: string; fieldId: number; fileId: string },
) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/fieldFile.remove`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json: { token, fieldId, fileId } }),
  });

const signFieldWithRequest = async (
  request: APIRequestContext,
  token: string,
  fieldId: number,
  fieldValue: Record<string, unknown>,
) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json: { token, fieldId, fieldValue } }),
  });

const signField = async (page: Page, token: string, fieldId: number, value: string) =>
  await signFieldWithRequest(page.context().request, token, fieldId, { type: FieldType.SIGNATURE, value });

/**
 * The certificate is drawn glyph by glyph, so the extracted text comes out of order.
 * Rebuild each line from the character positions, without spaces.
 */
const readTextByPosition = (pageText: ReturnType<PDF['extractText']>[number]) => {
  const chars = pageText.lines.flatMap((line) => line.spans.flatMap((span) => span.chars));
  const lines = new Map<number, typeof chars>();

  for (const char of chars) {
    const key = Math.round(char.baseline);

    lines.set(key, [...(lines.get(key) ?? []), char]);
  }

  return [...lines.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, lineChars]) =>
      lineChars
        .sort((a, b) => a.bbox.x - b.bbox.x)
        .map((char) => char.char)
        .join('')
        .replace(/\s+/g, ''),
    )
    .join('\n');
};

const createDirectLink = async (request: APIRequestContext, token: string, envelope: TGetEnvelopeResponse) =>
  await request.post(`${API_BASE_URL}/template/direct/create`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { templateId: mapSecondaryIdToTemplateId(envelope.secondaryId) },
  });

const postTrpc = async (
  request: APIRequestContext,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = {},
  isWrapped = false,
) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', ...headers },
    data: JSON.stringify(isWrapped ? input : { json: input }),
  });

const readTrpc = async <T>(response: APIResponse): Promise<T> => {
  const body = await response.json();

  return body.result.data.json as T;
};

const expectOk = async (response: Promise<APIResponse>) => {
  const resolved = await response;

  expect(resolved.ok(), await resolved.text()).toBe(true);

  return resolved;
};

const openSigningPage = async (page: Page, token: string) => {
  await page.goto(`/sign/${token}`);

  await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 60_000 });
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });
};

const clickField = async (page: Page, field: EnvelopeField) => {
  const canvasBox = await getCanvasBox(page);

  await getPageCanvas(page).click({
    position: {
      x: ((Number(field.positionX) + Number(field.width) / 2) / 100) * canvasBox.width,
      y: ((Number(field.positionY) + Number(field.height) / 2) / 100) * canvasBox.height,
    },
  });
};

const chooseFile = async (page: Page, trigger: ReturnType<Page['getByRole']>, file: TestFile) => {
  const chooserPromise = page.waitForEvent('filechooser');

  await trigger.click();

  const chooser = await chooserPromise;

  await chooser.setFiles(file);
};
