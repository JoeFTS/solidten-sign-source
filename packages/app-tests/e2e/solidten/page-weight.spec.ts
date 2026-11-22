import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument } from '@cantoo/pdf-lib';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { getDocumentDataUrl, getEnvelopeItemPdfUrl } from '@documenso/lib/utils/envelope-download';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

// A page may carry ids, fields and text, never the document itself.
const MAX_PAGE_BYTES = 1024 * 1024;
const DOCUMENT_BYTES = 10 * 1024 * 1024;

test.describe.configure({ mode: 'serial' });

/**
 * A valid one-page PDF of about 10 MB: an image of random pixels, which no compression shrinks.
 */
const makeLargePdf = async () => {
  const width = 1900;
  const height = Math.ceil(DOCUMENT_BYTES / (width * 3));

  const raw = Buffer.alloc((width * 3 + 1) * height);

  for (let row = 0; row < height; row++) {
    const offset = row * (width * 3 + 1);
    raw[offset] = 0;
    crypto.getRandomValues(raw.subarray(offset + 1, offset + 1 + width * 3));
  }

  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));

    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const image = await pdf.embedPng(png);

  page.drawImage(image, { x: 50, y: 300, width: 512, height: 400 });

  return Buffer.from(await pdf.save());
};

/**
 * Put the large PDF behind every envelope item of an envelope, as an upload would.
 */
const useLargePdf = async (envelopeId: string, pdf: Buffer) => {
  const items = await prisma.envelopeItem.findMany({ where: { envelopeId } });
  const base64 = pdf.toString('base64');

  for (const item of items) {
    await prisma.documentData.update({
      where: { id: item.documentDataId },
      data: { data: base64, initialData: base64 },
    });
  }
};

const htmlSize = async (request: APIRequestContext, path: string) => {
  const url = path.startsWith('http') ? path : `${WEBAPP_BASE_URL}${path}`;
  const response = await request.get(url, { maxRedirects: 0 });

  expect(response.status(), `${path} answered ${response.status()}`).toBe(200);

  return (await response.body()).length;
};

test('no page carries the document bytes of a 10 MB document', async ({ page, request }) => {
  test.setTimeout(240_000);

  const pdf = await makeLargePdf();

  expect(pdf.length).toBeGreaterThan(DOCUMENT_BYTES * 0.9);

  const { envelope, user, team, distributeResult } = await apiSeedPendingDocument(request, {
    recipients: [{ email: 'page-weight-signer@test.documenso.com', name: 'Weight Signer' }],
    fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 }]],
  });

  await useLargePdf(envelope.id, pdf);

  const token = distributeResult.recipients[0].token;

  const { user: formOwner, team: formTeam } = await seedUser();
  const template = await seedDirectTemplate({
    title: `Page weight form ${Date.now()}`,
    userId: formOwner.id,
    teamId: formTeam.id,
    internalVersion: 2,
  });

  await useLargePdf(template.id, pdf);

  // A version-1 document uses the legacy signing page.
  const legacy = await seedPendingDocument(user, team.id, ['page-weight-legacy@test.documenso.com']);

  await useLargePdf(legacy.id, pdf);

  const legacyToken = (await prisma.recipient.findFirstOrThrow({ where: { envelopeId: legacy.id } })).token;

  const sizes: Record<string, number> = {};

  sizes['legacy (v1) signing page /sign/<token>'] = await htmlSize(request, `/sign/${legacyToken}`);
  sizes['legacy (v1) completion page'] = await htmlSize(request, `/sign/${legacyToken}/complete`);

  sizes['signing page /sign/<token>'] = await htmlSize(request, `/sign/${token}`);
  sizes['completion page /sign/<token>/complete'] = await htmlSize(request, `/sign/${token}/complete`);
  sizes['embed signing /embed/sign/<token>'] = await htmlSize(request, `/embed/sign/${token}`);
  sizes['public form /d/<token>'] = await htmlSize(request, formatDirectTemplatePath(template.directLink?.token ?? ''));
  sizes['embed form /embed/direct/<token>'] = await htmlSize(request, `/embed/direct/${template.directLink?.token}`);

  await apiSignin({ page, email: user.email });

  sizes['sender document page'] = await htmlSize(page.context().request, `/t/${team.url}/documents/${envelope.id}`);
  sizes['sender editor'] = await htmlSize(page.context().request, `/t/${team.url}/documents/${envelope.id}/edit`);

  await apiSignin({ page, email: formOwner.email });

  sizes['template page'] = await htmlSize(page.context().request, `/t/${formTeam.url}/templates/${template.id}`);
  sizes['template editor'] = await htmlSize(page.context().request, `/t/${formTeam.url}/templates/${template.id}/edit`);

  // In-person signing: the host starts a session and hands the device to the signer.
  await apiSignin({ page, email: user.email });

  const start = await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/inPerson.start`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(team.id) },
    data: JSON.stringify({ json: { envelopeId: envelope.id, pin: '4826', emailCodeRecipientIds: [] } }),
  });

  expect(start.ok(), await start.text()).toBe(true);

  const sessionId: string = (await start.json()).result.data.json.sessionId;

  await page.goto(`/in-person/${sessionId}`);
  await page.getByRole('button', { name: 'Hand over to sign' }).click();
  await page.getByLabel('Your full name').fill('Weight Signer');
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByTestId('in-person-signing-bar')).toBeVisible({ timeout: 30_000 });

  sizes['in-person signing page'] = await htmlSize(page.context().request, `/in-person/${sessionId}/sign`);

  // The QR share page of a completed document.
  const qrToken = `qr_pageweight${Date.now()}`;

  await prisma.envelope.update({ where: { id: envelope.id }, data: { status: 'COMPLETED', qrToken } });

  sizes['QR share page /share/<qr token>'] = await htmlSize(request, `/share/${qrToken}`);
  sizes['completion page, completed document'] = await htmlSize(request, `/sign/${token}/complete`);

  console.log(JSON.stringify(sizes, null, 2));

  for (const [name, size] of Object.entries(sizes)) {
    expect(size, `${name}: ${size} bytes`).toBeLessThan(MAX_PAGE_BYTES);
  }
});

test('the PDF is not served by token before the access check is passed', async ({ browser, request }) => {
  const { user: signer } = await seedUser();
  const { user: stranger } = await seedUser();

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    globalAccessAuth: ['ACCOUNT'],
    recipients: [{ email: signer.email, name: 'Account Signer' }],
    fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 }]],
  });

  const token = distributeResult.recipients[0].token;
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  const urls = [
    getDocumentDataUrl({
      envelopeId: envelope.id,
      envelopeItemId: item.id,
      documentDataId: item.documentDataId,
      token,
      version: 'current',
    }),
    getEnvelopeItemPdfUrl({ type: 'view', envelopeItem: item, token }),
    getEnvelopeItemPdfUrl({ type: 'download', envelopeItem: item, token, version: 'original' }),
  ];

  const statuses = async (email?: string) => {
    const context = await browser.newContext();

    if (email) {
      await apiSignin({ page: await context.newPage(), email });
    }

    const result = await Promise.all(urls.map(async (url) => (await context.request.get(url)).status()));

    await context.close();

    return result;
  };

  // Signed out, or signed in as someone else: the gate on the signing page would stop them.
  expect(await statuses()).toEqual([404, 404, 404]);
  expect(await statuses(stranger.email)).toEqual([404, 404, 404]);

  // The recipient's own account passes the gate.
  expect(await statuses(signer.email)).toEqual([200, 200, 200]);
});
