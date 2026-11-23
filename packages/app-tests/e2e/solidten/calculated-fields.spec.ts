import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import {
  mapDocumentIdToSecondaryId,
  mapSecondaryIdToDocumentId,
  mapSecondaryIdToTemplateId,
} from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import type { TGetEnvelopeResponse } from '@documenso/trpc/server/envelope-router/get-envelope.types';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

import { apiSeedDraftDocument, apiSeedPendingDocument, apiSeedTemplate } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { getCanvasBox, getPageCanvas } from '../fixtures/contents';
import { getKonvaFieldTextForPage } from '../fixtures/konva';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const API_BASE_URL = `${WEBAPP_BASE_URL}/api/v2-beta`;

const numberField = (label: string, positionY: number, meta: Record<string, unknown> = {}) => ({
  type: FieldType.NUMBER,
  page: 1,
  positionX: 5,
  positionY,
  width: 25,
  height: 5,
  fieldMeta: { type: 'number', label, ...meta },
});

const signatureField = { type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 };

test.describe('Solid Ten calculated fields', () => {
  test('the total updates as the signer types and the signer cannot edit it', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'calculated-ui@test.documenso.com', name: 'Calculated Signer' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Price', 5, { fieldKey: 'price' }),
          numberField('Quantity', 15, { fieldKey: 'qty' }),
          numberField('Total', 25, { formula: '{{price}} * {{qty}}', required: true }),
          numberField('Change', 35, { formula: '{{qty}} - {{price}}', numberFormat: '123,456,789.00' }),
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const priceField = findField(envelope, 'Price');
    const quantityField = findField(envelope, 'Quantity');
    const totalField = findField(envelope, 'Total');
    const changeField = findField(envelope, 'Change');

    await openSigningPage(page, token);

    // Only the signature is left for the signer: calculated fields are never required.
    await expect(page.getByText('1 Field Remaining').first()).toBeVisible();

    await fillNumberField(page, priceField, '12.5');
    await fillNumberField(page, quantityField, '3');

    await expect.poll(() => getKonvaFieldTextForPage(page, 1, totalField.id)).toBe('37.5');
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, changeField.id)).toBe('-9.50');

    await clickField(page, totalField);
    await expect(page.getByRole('dialog')).toBeHidden();

    const storedTotal = await prisma.field.findUniqueOrThrow({ where: { id: totalField.id } });
    const storedChange = await prisma.field.findUniqueOrThrow({ where: { id: changeField.id } });

    expect([storedTotal.inserted, storedTotal.customText]).toEqual([true, '37.5']);
    expect([storedChange.inserted, storedChange.customText]).toEqual([true, '-9.50']);

    const calculatedAuditLogs = await prisma.documentAuditLog.findMany({
      where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_CALCULATED },
      orderBy: { createdAt: 'asc' },
    });

    const totalAuditLog = calculatedAuditLogs.find(
      (auditLog) => (auditLog.data as { fieldId?: string }).fieldId === storedTotal.secondaryId,
    );

    expect(totalAuditLog?.data).toEqual(
      expect.objectContaining({ fieldId: storedTotal.secondaryId, value: '37.5', formula: '{{price}} * {{qty}}' }),
    );
    expect(calculatedAuditLogs.every((auditLog) => auditLog.email === 'calculated-ui@test.documenso.com')).toBe(true);

    // Removing a source empties the total again, and the field says which source is missing.
    await clickField(page, quantityField);
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, totalField.id)).toBe('Fill in Quantity');
    expect((await prisma.field.findUniqueOrThrow({ where: { id: totalField.id } })).inserted).toBe(false);
  });

  test('the server computes the value and refuses values sent by a signer', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'calculated-api@test.documenso.com', name: 'Tampering Signer' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Net', 5, { fieldKey: 'net' }),
          numberField('Divisor', 15, { fieldKey: 'divisor' }),
          numberField('Share', 25, { formula: 'ROUND({{net}} / {{divisor}}, 2)' }),
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const netField = findField(envelope, 'Net');
    const divisorField = findField(envelope, 'Divisor');
    const shareField = findField(envelope, 'Share');

    const forged = await signField(page, token, shareField.id, { type: FieldType.NUMBER, value: '1000000' });

    expect(forged.ok()).toBe(false);
    expect(await forged.text()).toContain('is calculated for you and cannot be filled in.');

    await expectOk(signField(page, token, netField.id, { type: FieldType.NUMBER, value: '10' }));

    const zeroResponse = await expectOk(
      signField(page, token, divisorField.id, { type: FieldType.NUMBER, value: '0' }),
    );

    // Division by zero is an empty value, not an error.
    expect((await prisma.field.findUniqueOrThrow({ where: { id: shareField.id } })).inserted).toBe(false);
    expect((await zeroResponse.json()).result.data.json.affectedFields ?? []).toEqual([]);

    await expectOk(signField(page, token, divisorField.id, { type: FieldType.NUMBER, value: null }));

    const threeResponse = await expectOk(
      signField(page, token, divisorField.id, { type: FieldType.NUMBER, value: '3' }),
    );

    expect((await threeResponse.json()).result.data.json.affectedFields).toEqual([
      expect.objectContaining({ id: shareField.id, inserted: true, customText: '3.33' }),
    ]);

    // A value written straight to the database is recomputed before completion.
    await prisma.field.update({ where: { id: shareField.id }, data: { customText: '999', inserted: true } });

    await expectOk(
      signField(page, token, findFieldByType(envelope, FieldType.SIGNATURE).id, {
        type: FieldType.SIGNATURE,
        value: 'Tampering Signer',
      }),
    );

    await completeDocumentWithToken({ token, id: { type: 'envelopeId', id: envelope.id } });

    expect((await prisma.field.findUniqueOrThrow({ where: { id: shareField.id } })).customText).toBe('3.33');
    expect((await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } })).signingStatus).toBe(
      SigningStatus.SIGNED,
    );
  });

  test('a number that does not match its format exactly is refused, never misread', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'calculated-format@test.documenso.com', name: 'Format Signer' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Hours', 5, { fieldKey: 'hours', numberFormat: '123456,789.00' }),
          numberField('Pay', 15, { formula: '{{hours}} * 2' }),
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const hoursField = findField(envelope, 'Hours');
    const payField = findField(envelope, 'Pay');

    // "1234,5" used to be read as 12345, a total ten times too large.
    const ambiguous = await signField(page, token, hoursField.id, { type: FieldType.NUMBER, value: '1234,5' });

    expect(ambiguous.ok()).toBe(false);
    expect(await ambiguous.text()).toContain('does not match the number format 123456,789.00');
    expect((await prisma.field.findUniqueOrThrow({ where: { id: payField.id } })).inserted).toBe(false);

    await expectOk(signField(page, token, hoursField.id, { type: FieldType.NUMBER, value: '1234,567.5' }));

    expect((await prisma.field.findUniqueOrThrow({ where: { id: payField.id } })).customText).toBe('2469135');

    // The signing dialog refuses the same input before it reaches the server.
    await expectOk(signField(page, token, hoursField.id, { type: FieldType.NUMBER, value: null }));
    await openSigningPage(page, token);
    await clickField(page, hoursField);

    const dialog = page.getByRole('dialog');

    await dialog.getByRole('textbox').fill('1234,5');
    await dialog.getByRole('button', { name: 'Enter' }).click();
    await expect(dialog.getByText('Number needs to be formatted as 123456,789.00')).toBeVisible();
  });

  test('a formula can count empty sources as zero, and an empty total says why', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'calculated-zero@test.documenso.com', name: 'Zero Signer' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Hours', 5, { fieldKey: 'hours' }),
          numberField('Extra', 15, { fieldKey: 'extra' }),
          numberField('Strict', 25, { formula: '{{hours}} + {{extra}}' }),
          numberField('Lenient', 35, { formula: '{{hours}} + {{extra}}', formulaEmptySourcesAsZero: true }),
          numberField('Ratio', 45, { formula: '{{hours}} / {{extra}}', formulaEmptySourcesAsZero: true }),
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;

    await expectOk(signField(page, token, findField(envelope, 'Hours').id, { type: FieldType.NUMBER, value: '8' }));

    const stored = async (label: string) =>
      (await prisma.field.findUniqueOrThrow({ where: { id: findField(envelope, label).id } })).customText;

    expect([await stored('Strict'), await stored('Lenient'), await stored('Ratio')]).toEqual(['', '8', '']);

    await openSigningPage(page, token);

    await expect.poll(() => getKonvaFieldTextForPage(page, 1, findField(envelope, 'Strict').id)).toBe('Fill in Extra');
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, findField(envelope, 'Lenient').id)).toBe('8');
    await expect
      .poll(() => getKonvaFieldTextForPage(page, 1, findField(envelope, 'Ratio').id))
      .toBe('Cannot divide by zero');
  });

  test('a malformed number prefill through template/use is refused and names the field', async ({ request }) => {
    const { envelope: template, token } = await apiSeedTemplate(request, {
      recipients: [{ email: 'calculated-prefill@test.documenso.com', name: 'Prefill Signer', role: 'SIGNER' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Hours', 5, { fieldKey: 'hours', numberFormat: '123,456,789.00' }),
          numberField('Pay', 15, { formula: '{{hours}} * 2', numberFormat: '123,456,789.00' }),
        ],
      ],
    });

    const hoursField = findField(template, 'Hours');

    const useTemplate = async (value: string) =>
      await request.post(`${API_BASE_URL}/template/use`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          templateId: mapSecondaryIdToTemplateId(template.secondaryId),
          recipients: [
            { id: template.recipients[0].id, email: 'calculated-prefill@test.documenso.com', name: 'Prefill Signer' },
          ],
          prefillFields: [{ id: hoursField.id, type: 'number', value }],
          distributeDocument: true,
        },
      });

    const malformed = await useTemplate('1234,5');

    expect(malformed.status()).toBe(400);
    expect(await malformed.text()).toContain('Hours');
    expect(await malformed.text()).toContain('does not match the number format 123,456,789.00');

    const wellFormed = await useTemplate('1,234.5');

    expect(wellFormed.ok(), await wellFormed.text()).toBe(true);

    const { id } = await wellFormed.json();
    const document = await prisma.envelope.findFirstOrThrow({
      where: { secondaryId: mapDocumentIdToSecondaryId(id) },
      include: { fields: true },
    });
    const pay = document.fields.find((field) => (field.fieldMeta as { label?: string }).label === 'Pay');

    expect(pay?.customText).toBe('2,469.00');
  });

  test('an unknown number format is refused when a field is saved', async ({ request }) => {
    const { envelope, token } = await apiSeedDraftDocument(request, {
      recipients: [{ email: 'calculated-format-save@test.documenso.com', name: 'Format' }],
    });

    const response = await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        envelopeId: envelope.id,
        data: [
          {
            recipientId: envelope.recipients[0].id,
            envelopeItemId: envelope.envelopeItems[0].id,
            type: FieldType.NUMBER,
            page: 1,
            positionX: 5,
            positionY: 5,
            width: 10,
            height: 5,
            fieldMeta: { type: 'number', numberFormat: 'foo' },
          },
        ],
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.text();

    expect(body).toContain('has an unknown number format');
    expect(body).toContain('foo');
    expect(await prisma.field.count({ where: { envelopeId: envelope.id } })).toBe(0);
  });

  test('the v1 API field routes run the same number and rule checks as v2', async ({ request }) => {
    const { envelope, token } = await apiSeedDraftDocument(request, {
      recipients: [
        { email: 'calculated-v1-a@test.documenso.com', name: 'First' },
        { email: 'calculated-v1-b@test.documenso.com', name: 'Second' },
      ],
    });

    const [first, second] = envelope.recipients;
    const v1FieldsUrl = `${WEBAPP_BASE_URL}/api/v1/documents/${mapSecondaryIdToDocumentId(envelope.secondaryId)}/fields`;
    const position = { pageNumber: 1, pageX: 5, pageY: 5, pageWidth: 10, pageHeight: 5 };

    const createV1 = async (data: Record<string, unknown>) =>
      await request.post(v1FieldsUrl, {
        headers: { Authorization: `Bearer ${token}` },
        data: { ...position, ...data },
      });

    const badValue = await createV1({
      recipientId: first.id,
      type: 'NUMBER',
      fieldMeta: { type: 'number', numberFormat: '123,456,789.00', value: '1234,5', readOnly: true },
    });

    expect(badValue.status()).toBe(400);
    expect(await badValue.text()).toContain('does not match the number format 123,456,789.00');

    const badFormat = await createV1({
      recipientId: first.id,
      type: 'NUMBER',
      fieldMeta: { type: 'number', numberFormat: 'foo' },
    });

    expect(badFormat.status()).toBe(400);
    expect(await badFormat.text()).toContain('has an unknown number format');

    expect(await prisma.field.count({ where: { envelopeId: envelope.id } })).toBe(0);

    const base = await createV1({
      recipientId: first.id,
      type: 'NUMBER',
      fieldMeta: { type: 'number', label: 'Base', fieldKey: 'base', numberFormat: '123,456,789.00' },
    });

    expect(base.ok(), await base.text()).toBe(true);

    // A rule that reaches another recipient is refused on v1 as on v2.
    const crossRecipient = await createV1({
      recipientId: second.id,
      type: 'NUMBER',
      fieldMeta: { type: 'number', formula: '{{base}} * 2' },
    });

    expect(crossRecipient.status()).toBe(400);
    expect(await crossRecipient.text()).toContain('belongs to another recipient');

    // A refused v1 PATCH answers 400 with the reason, not 401.
    const baseFieldId = (await base.json()).fields[0].id;

    const patch = await request.patch(`${v1FieldsUrl}/${baseFieldId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        ...position,
        recipientId: first.id,
        type: 'NUMBER',
        fieldMeta: { type: 'number', label: 'Base', numberFormat: '123,456,789.00', value: '1234,5' },
      },
    });

    expect(patch.status()).toBe(400);
    expect(await patch.text()).toContain('does not match the number format');
  });

  test('the empty-total hint follows the sources while signing, without a reload', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'calculated-hint@test.documenso.com', name: 'Hint Signer' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Rate', 5, { fieldKey: 'rate' }),
          numberField('Hours', 15, { fieldKey: 'hours' }),
          numberField('Fee', 25, { formula: '{{rate}} * {{hours}}' }),
        ],
      ],
    });

    const feeField = findField(envelope, 'Fee');

    await openSigningPage(page, distributeResult.recipients[0].token);
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, feeField.id)).toBe('Fill in Rate, Hours');

    await fillNumberField(page, findField(envelope, 'Rate'), '50');
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, feeField.id)).toBe('Fill in Hours');

    await fillNumberField(page, findField(envelope, 'Hours'), '2');
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, feeField.id)).toBe('100');
  });

  test('prefilled sources are calculated when the document is sent', async ({ request }) => {
    const { envelope } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'calculated-send@test.documenso.com', name: 'Send Signer' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Base', 5, { fieldKey: 'base', value: '1000', readOnly: true }),
          numberField('Fee', 15, { fieldKey: 'fee', value: '2.5', readOnly: true }),
          numberField('Grand total', 25, {
            formula: 'SUM({{base}}, {{fee}}) * -1',
            numberFormat: '123.456.789,00',
          }),
        ],
      ],
    });

    const grandTotal = await prisma.field.findUniqueOrThrow({ where: { id: findField(envelope, 'Grand total').id } });

    expect([grandTotal.inserted, grandTotal.customText]).toEqual([true, '-1.002,50']);
  });

  test('bad formulas are rejected when fields are saved', async ({ request }) => {
    const { envelope, token } = await apiSeedDraftDocument(request, {
      recipients: [
        { email: 'calculated-save-1@test.documenso.com', name: 'First' },
        { email: 'calculated-save-2@test.documenso.com', name: 'Second' },
      ],
    });

    const [first, second] = envelope.recipients;

    const createFields = async (fields: Record<string, unknown>[]) =>
      await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          envelopeId: envelope.id,
          data: fields.map((field) => ({
            envelopeItemId: envelope.envelopeItems[0].id,
            page: 1,
            positionX: 5,
            width: 10,
            height: 5,
            ...field,
          })),
        },
      });

    const cycle = await createFields([
      {
        recipientId: first.id,
        type: FieldType.NUMBER,
        positionY: 5,
        fieldMeta: { type: 'number', fieldKey: 'a', formula: '{{b}} + 1' },
      },
      {
        recipientId: first.id,
        type: FieldType.NUMBER,
        positionY: 15,
        fieldMeta: { type: 'number', fieldKey: 'b', formula: '{{a}} * 2' },
      },
    ]);

    expect(cycle.status()).toBe(400);
    expect(await cycle.text()).toContain('loop');

    const syntax = await createFields([
      {
        recipientId: first.id,
        type: FieldType.NUMBER,
        positionY: 5,
        fieldMeta: { type: 'number', formula: 'eval(1)' },
      },
    ]);

    expect(syntax.status()).toBe(400);
    expect(await syntax.text()).toContain('not a known function');

    await expectOk(
      createFields([
        {
          recipientId: first.id,
          type: FieldType.NUMBER,
          positionY: 5,
          fieldMeta: { type: 'number', fieldKey: 'mine' },
        },
      ]),
    );

    const crossRecipient = await createFields([
      {
        recipientId: second.id,
        type: FieldType.NUMBER,
        positionY: 25,
        fieldMeta: { type: 'number', formula: '{{mine}} * 2' },
      },
    ]);

    expect(crossRecipient.status()).toBe(400);
    expect(await crossRecipient.text()).toContain('belongs to another recipient');

    expect(await prisma.field.count({ where: { envelopeId: envelope.id } })).toBe(1);
  });

  test('a sender writes a formula in the editor', async ({ page, request }) => {
    const { envelope, user, team } = await apiSeedDraftDocument(request, {
      recipients: [{ email: 'calculated-editor@test.documenso.com', name: 'Editor Signer' }],
      fieldsPerRecipient: [
        [
          signatureField,
          numberField('Price', 5, { fieldKey: 'price' }),
          { ...numberField('Total', 40, {}), positionX: 40, width: 30, height: 6 },
        ],
      ],
    });

    const totalField = findField(envelope, 'Total');

    await apiSignin({
      page,
      email: user.email,
      redirectPath: `/t/${team.url}/documents/${envelope.id}/edit?step=addFields`,
    });

    await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);

    await clickField(page, totalField, { force: true });

    await page.getByTestId('field-logic-expand').click();

    const formulaInput = page.getByTestId('field-logic-formula');

    // The examples show their curly brackets (they were lost as message placeholders: "{} * {}").
    await expect(formulaInput).toHaveAttribute('placeholder', 'For example: {{price}} * {{quantity}}');
    await expect(page.getByText('for example {{price}}.', { exact: false })).toBeVisible();

    await formulaInput.fill('{{price}} *');
    await expect(page.getByTestId('field-logic-formula-error')).toContainText('ends too early');

    await formulaInput.fill('{{price}} * 2');
    await expect(page.getByTestId('field-logic-formula-error')).toBeHidden();

    await expect
      .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: totalField.id } })).fieldMeta, {
        timeout: 15_000,
      })
      .toMatchObject({ formula: '{{price}} * 2' });

    await page.getByTestId('field-logic-formula-empty-as-zero').click();

    await expect
      .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: totalField.id } })).fieldMeta, {
        timeout: 15_000,
      })
      .toMatchObject({ formula: '{{price}} * 2', formulaEmptySourcesAsZero: true });
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

const signField = async (page: Page, token: string, fieldId: number, fieldValue: Record<string, unknown>) =>
  await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json: { token, fieldId, fieldValue } }),
  });

const expectOk = async <T extends { ok: () => boolean; text: () => Promise<string> }>(response: Promise<T>) => {
  const resolved = await response;

  expect(resolved.ok(), await resolved.text()).toBe(true);

  return resolved;
};

const openSigningPage = async (page: Page, token: string) => {
  await page.goto(`/sign/${token}`);

  await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 30_000 });
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });
};

const clickField = async (page: Page, field: EnvelopeField, options: { force?: boolean } = {}) => {
  const canvasBox = await getCanvasBox(page);

  await getPageCanvas(page).click({
    force: options.force,
    position: {
      x: ((Number(field.positionX) + Number(field.width) / 2) / 100) * canvasBox.width,
      y: ((Number(field.positionY) + Number(field.height) / 2) / 100) * canvasBox.height,
    },
  });
};

const fillNumberField = async (page: Page, field: EnvelopeField, value: string) => {
  const dialog = page.getByRole('dialog');

  await clickField(page, field);
  await dialog.getByRole('textbox').fill(value);
  await dialog.getByRole('button', { name: 'Enter' }).click();
  await expect.poll(() => getKonvaFieldTextForPage(page, 1, field.id)).toBe(value);
};
