import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import type { TGetEnvelopeResponse } from '@documenso/trpc/server/envelope-router/get-envelope.types';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';
import type Konva from 'konva';

import { apiSeedDraftDocument, apiSeedPendingDocument, apiSeedTemplate } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { getCanvasBox, getPageCanvas } from '../fixtures/contents';
import { getKonvaFieldTextForPage } from '../fixtures/konva';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const API_BASE_URL = `${WEBAPP_BASE_URL}/api/v2-beta`;

const CHECKBOX_META = {
  type: 'checkbox',
  fieldKey: 'needsInvoice',
  values: [{ id: 1, checked: false, value: 'Yes' }],
};

test.describe('Solid Ten conditional fields', () => {
  test('a field appears, is required and is cleared as its condition changes', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'conditional-ui@test.documenso.com', name: 'Conditional Signer' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 30,
            height: 5,
            fieldMeta: { type: 'text', label: 'Company', fieldKey: 'company' },
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 35,
            width: 30,
            height: 5,
            fieldMeta: {
              type: 'text',
              label: 'VAT number',
              required: true,
              condition: { fieldKey: 'company', operator: 'notEmpty' },
            },
          },
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const companyField = findField(envelope, 'Company');
    const vatField = findField(envelope, 'VAT number');

    await openSigningPage(page, token);

    await expect.poll(() => isFieldOnCanvas(page, companyField.id)).toBe(true);
    expect(await isFieldOnCanvas(page, vatField.id)).toBe(false);
    await expect(page.getByText('1 Field Remaining').first()).toBeVisible();

    await fillTextField(page, companyField, 'Acme');

    await expect.poll(() => isFieldOnCanvas(page, vatField.id)).toBe(true);
    await expect(page.getByText('2 Fields Remaining').first()).toBeVisible();

    await fillTextField(page, vatField, 'NL123');
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, vatField.id)).toBe('NL123');

    // Clearing the source would empty the VAT number, so the signer is asked first.
    const confirmDialog = page.getByTestId('field-logic-clear-confirm');

    await clickField(page, companyField);
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(confirmDialog).toContainText('This removes 1 answer.');
    await confirmDialog.getByRole('button', { name: 'Keep' }).click();

    await expect(confirmDialog).toBeHidden();
    expect(await isFieldOnCanvas(page, vatField.id)).toBe(true);
    expect((await prisma.field.findUniqueOrThrow({ where: { id: companyField.id } })).inserted).toBe(true);
    expect((await prisma.field.findUniqueOrThrow({ where: { id: vatField.id } })).customText).toBe('NL123');

    await clickField(page, companyField);
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await confirmDialog.getByRole('button', { name: 'Remove' }).click();

    await expect.poll(() => isFieldOnCanvas(page, vatField.id)).toBe(false);

    const clearedVatField = await prisma.field.findUniqueOrThrow({ where: { id: vatField.id } });

    expect(clearedVatField.inserted).toBe(false);
    expect(clearedVatField.customText).toBe('');

    const clearedAuditLogs = await prisma.documentAuditLog.findMany({
      where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_CONDITION_CLEARED },
    });

    expect(clearedAuditLogs).toHaveLength(1);
    expect(clearedAuditLogs[0].data).toEqual(
      expect.objectContaining({ fieldId: clearedVatField.secondaryId, conditionFieldKey: 'company' }),
    );
    expect(clearedAuditLogs[0].email).toBe('conditional-ui@test.documenso.com');

    // The hidden VAT field is required, but it must not block completion.
    await page.getByTestId('signature-pad-dialog-button').click();
    await page.getByRole('tab', { name: 'Type' }).click();
    await page.getByTestId('signature-pad-type-input').fill('Signature');
    await page.getByRole('button', { name: 'Next' }).click();

    await clickField(page, findFieldByType(envelope, FieldType.SIGNATURE));
    await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByRole('button', { name: 'Sign' }).click();
    await page.waitForURL(`/sign/${token}/complete`);

    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    expect(recipient.signingStatus).toBe(SigningStatus.SIGNED);
  });

  test('on a phone, clearing a source that hides a file and an answer asks first', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'conditional-phone@test.documenso.com', name: 'Phone Signer' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 40,
            height: 6,
            fieldMeta: { type: 'text', label: 'Company', fieldKey: 'company' },
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 35,
            width: 40,
            height: 6,
            fieldMeta: { type: 'text', label: 'VAT number', condition: { fieldKey: 'company', operator: 'notEmpty' } },
          },
          {
            type: FieldType.FILE,
            page: 1,
            positionX: 5,
            positionY: 50,
            width: 40,
            height: 6,
            fieldMeta: {
              type: 'file',
              label: 'Registration',
              condition: { fieldKey: 'company', operator: 'notEmpty' },
            },
          },
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const companyField = findField(envelope, 'Company');
    const fileField = findField(envelope, 'Registration');

    await expectOk(signField(page, token, companyField.id, { type: FieldType.TEXT, value: 'Acme' }));
    await expectOk(
      signField(page, token, findField(envelope, 'VAT number').id, { type: FieldType.TEXT, value: 'NL1' }),
    );
    await expectOk(
      page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/fieldFile.upload`, {
        headers: WEBAPP_ORIGIN_HEADERS,
        multipart: {
          payload: JSON.stringify({ token, fieldId: fileField.id }),
          file: {
            name: 'registration.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from('%PDF-1.4\n% x\n%%EOF\n'),
          },
        },
      }),
    );

    await openSigningPage(page, token);

    const confirmDialog = page.getByTestId('field-logic-clear-confirm');

    await clickField(page, companyField);
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(confirmDialog).toContainText('This removes 1 file and 1 answer.');
    await confirmDialog.getByRole('button', { name: 'Remove' }).click();

    await expect.poll(async () => await prisma.fieldFileUpload.count({ where: { fieldId: fileField.id } })).toBe(0);
    expect((await prisma.field.findUniqueOrThrow({ where: { id: companyField.id } })).inserted).toBe(false);
  });

  test('[S-L2] the legacy field routes refuse a version-2 document with field rules', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'conditional-legacy@test.documenso.com', name: 'Legacy Signer' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.CHECKBOX,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 20,
            height: 5,
            fieldMeta: CHECKBOX_META,
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 35,
            width: 30,
            height: 5,
            fieldMeta: {
              type: 'text',
              label: 'Hidden text',
              condition: { fieldKey: 'needsInvoice', operator: 'checked' },
            },
          },
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const hidden = findField(envelope, 'Hidden text');

    const legacy = async (path: string, json: Record<string, unknown>) =>
      await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
        data: JSON.stringify({ json }),
      });

    const signed = await legacy('field.signFieldWithToken', {
      token,
      fieldId: hidden.id,
      value: 'injected hidden text',
      isBase64: false,
    });
    expect(signed.ok()).toBe(false);
    expect(await signed.text()).toContain('uses field rules');

    const unsigned = await legacy('field.removeSignedFieldWithToken', { token, fieldId: hidden.id });
    expect(unsigned.ok()).toBe(false);

    const stored = await prisma.field.findUniqueOrThrow({ where: { id: hidden.id } });
    expect(stored.inserted).toBe(false);
    expect(stored.customText).toBe('');

    expect(
      await prisma.documentAuditLog.count({
        where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED },
      }),
    ).toBe(0);
  });

  test('the server enforces the condition against a signer who calls the API directly', async ({ page, request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'conditional-api@test.documenso.com', name: 'Tampering Signer' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.CHECKBOX,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 20,
            height: 5,
            fieldMeta: CHECKBOX_META,
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 35,
            width: 30,
            height: 5,
            fieldMeta: {
              type: 'text',
              label: 'Invoice address',
              required: true,
              condition: { fieldKey: 'needsInvoice', operator: 'checked', value: 'Yes' },
            },
          },
        ],
      ],
    });

    const token = distributeResult.recipients[0].token;
    const checkboxField = findFieldByType(envelope, FieldType.CHECKBOX);
    const addressField = findField(envelope, 'Invoice address');
    const signatureField = findFieldByType(envelope, FieldType.SIGNATURE);

    const hiddenResponse = await signField(page, token, addressField.id, { type: FieldType.TEXT, value: 'Main St 1' });

    expect(hiddenResponse.ok()).toBe(false);
    expect(await hiddenResponse.text()).toContain('is hidden by an answer you gave, so it cannot be filled in.');
    expect((await prisma.field.findUniqueOrThrow({ where: { id: addressField.id } })).inserted).toBe(false);

    await expectOk(signField(page, token, signatureField.id, { type: FieldType.SIGNATURE, value: 'Tampering Signer' }));
    await expectOk(signField(page, token, checkboxField.id, { type: FieldType.CHECKBOX, value: [0] }));

    // Shown and required now, so completion without it must fail.
    await expect(
      completeDocumentWithToken({ token, id: { type: 'envelopeId', id: envelope.id } }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_HAS_UNSIGNED_FIELDS' });

    await expectOk(signField(page, token, addressField.id, { type: FieldType.TEXT, value: 'Main St 1' }));

    const uncheckResponse = await signField(page, token, checkboxField.id, { type: FieldType.CHECKBOX, value: [] });
    const uncheckBody = await uncheckResponse.json();

    expect(uncheckResponse.ok()).toBe(true);
    expect(uncheckBody.result.data.json.affectedFields).toEqual([
      expect.objectContaining({ id: addressField.id, inserted: false, customText: '' }),
    ]);

    // Hidden again: the required address no longer blocks completion.
    await completeDocumentWithToken({ token, id: { type: 'envelopeId', id: envelope.id } });

    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    expect(recipient.signingStatus).toBe(SigningStatus.SIGNED);
  });

  test('rules that cannot work are rejected when fields are saved or sent', async ({ request }) => {
    const { envelope, token } = await apiSeedDraftDocument(request, {
      recipients: [
        { email: 'conditional-save-1@test.documenso.com', name: 'First' },
        { email: 'conditional-save-2@test.documenso.com', name: 'Second' },
      ],
    });

    const [first, second] = envelope.recipients;
    const itemId = envelope.envelopeItems[0].id;

    const createFields = async (fields: Record<string, unknown>[]) =>
      await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          envelopeId: envelope.id,
          data: fields.map((field) => ({ envelopeItemId: itemId, page: 1, width: 10, height: 5, ...field })),
        },
      });

    const cycle = await createFields([
      {
        recipientId: first.id,
        type: FieldType.TEXT,
        positionX: 5,
        positionY: 5,
        fieldMeta: { type: 'text', fieldKey: 'a', condition: { fieldKey: 'b', operator: 'notEmpty' } },
      },
      {
        recipientId: first.id,
        type: FieldType.TEXT,
        positionX: 5,
        positionY: 15,
        fieldMeta: { type: 'text', fieldKey: 'b', condition: { fieldKey: 'a', operator: 'notEmpty' } },
      },
    ]);

    expect(cycle.status()).toBe(400);
    expect(await cycle.text()).toContain('loop');

    await expectOk(
      createFields([
        { recipientId: first.id, type: FieldType.CHECKBOX, positionX: 5, positionY: 5, fieldMeta: CHECKBOX_META },
      ]),
    );

    const crossRecipient = await createFields([
      {
        recipientId: second.id,
        type: FieldType.TEXT,
        positionX: 40,
        positionY: 5,
        fieldMeta: { type: 'text', condition: { fieldKey: 'needsInvoice', operator: 'checked' } },
      },
    ]);

    expect(crossRecipient.status()).toBe(400);
    expect(await crossRecipient.text()).toContain('belongs to another recipient');

    // A key that points nowhere is allowed while editing, but blocks sending.
    await expectOk(
      createFields([
        { recipientId: first.id, type: FieldType.SIGNATURE, positionX: 5, positionY: 30 },
        { recipientId: second.id, type: FieldType.SIGNATURE, positionX: 40, positionY: 30 },
        {
          recipientId: first.id,
          type: FieldType.TEXT,
          positionX: 5,
          positionY: 45,
          fieldMeta: { type: 'text', condition: { fieldKey: 'deletedField', operator: 'notEmpty' } },
        },
      ]),
    );

    const distribute = await request.post(`${API_BASE_URL}/envelope/distribute`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { envelopeId: envelope.id },
    });

    expect(distribute.ok()).toBe(false);
    expect(await distribute.text()).toContain('no field has that key');

    const storedEnvelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

    expect(storedEnvelope.status).toBe('DRAFT');
  });

  test('a sender sets a key and a condition in the editor and edits keep them', async ({ page, request }) => {
    const { envelope, user, team } = await apiSeedDraftDocument(request, {
      recipients: [{ email: 'conditional-editor@test.documenso.com', name: 'Editor Signer' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.CHECKBOX,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 20,
            height: 5,
            fieldMeta: CHECKBOX_META,
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 40,
            positionY: 40,
            width: 30,
            height: 6,
            fieldMeta: { type: 'text', label: 'Invoice address' },
          },
        ],
      ],
    });

    const addressField = findField(envelope, 'Invoice address');

    await apiSignin({
      page,
      email: user.email,
      redirectPath: `/t/${team.url}/documents/${envelope.id}/edit?step=addFields`,
    });

    await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);

    const canvasBox = await getCanvasBox(page);

    await getPageCanvas(page).click({
      force: true,
      position: {
        x: ((Number(addressField.positionX) + Number(addressField.width) / 2) / 100) * canvasBox.width,
        y: ((Number(addressField.positionY) + Number(addressField.height) / 2) / 100) * canvasBox.height,
      },
    });

    await page.getByTestId('field-logic-expand').click();
    await expect(page.getByTestId('field-logic-form')).toBeVisible();

    await page.getByTestId('field-logic-key').fill('invoiceAddress');
    await page.getByTestId('field-logic-condition-source').click();
    await page.getByRole('option', { name: 'needsInvoice' }).click();

    await expect
      .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: addressField.id } })).fieldMeta, {
        timeout: 15_000,
      })
      .toMatchObject({
        fieldKey: 'invoiceAddress',
        condition: { fieldKey: 'needsInvoice', operator: 'checked' },
      });

    await page.getByTestId('field-form-label').fill('Billing address');

    await expect
      .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: addressField.id } })).fieldMeta, {
        timeout: 15_000,
      })
      .toMatchObject({
        label: 'Billing address',
        fieldKey: 'invoiceAddress',
        condition: { fieldKey: 'needsInvoice', operator: 'checked' },
      });
  });

  test('the rules panel works on a template with a public form', async ({ page, request }) => {
    const { envelope, token, user, team } = await apiSeedTemplate(request, {
      recipients: [{ email: 'conditional-form-editor@test.documenso.com', name: 'Form', role: 'SIGNER' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.CHECKBOX,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 20,
            height: 5,
            fieldMeta: CHECKBOX_META,
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 40,
            positionY: 40,
            width: 30,
            height: 6,
            fieldMeta: { type: 'text', label: 'Invoice address' },
          },
        ],
      ],
    });

    const created = await request.post(`${API_BASE_URL}/template/direct/create`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { templateId: mapSecondaryIdToTemplateId(envelope.secondaryId) },
    });

    expect(created.ok(), await created.text()).toBe(true);

    const addressField = findField(envelope, 'Invoice address');

    await openEditorAndSelectField(
      page,
      `/t/${team.url}/templates/${envelope.id}/edit?step=addFields`,
      user.email,
      addressField,
    );

    await expect(page.getByTestId('field-logic-unavailable')).toHaveCount(0);
    await page.getByTestId('field-logic-expand').click();
    await page.getByTestId('field-logic-condition-source').click();
    await page.getByRole('option', { name: 'needsInvoice' }).click();

    await expect
      .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: addressField.id } })).fieldMeta, {
        timeout: 15_000,
      })
      .toMatchObject({ condition: { fieldKey: 'needsInvoice', operator: 'checked' } });
  });

  test('a loop made in the editor shows its reason and no failed save', async ({ page, request }) => {
    const { envelope, user, team } = await apiSeedDraftDocument(request, {
      recipients: [{ email: 'conditional-loop@test.documenso.com', name: 'Loop' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 30,
            height: 6,
            fieldMeta: { type: 'text', label: 'First', fieldKey: 'first' },
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 40,
            positionY: 40,
            width: 30,
            height: 6,
            fieldMeta: {
              type: 'text',
              label: 'Second',
              fieldKey: 'second',
              condition: { fieldKey: 'first', operator: 'notEmpty' },
            },
          },
        ],
      ],
    });

    const firstField = findField(envelope, 'First');

    await openEditorAndSelectField(
      page,
      `/t/${team.url}/documents/${envelope.id}/edit?step=addFields`,
      user.email,
      firstField,
    );

    await expect(page.getByTestId('field-logic-form')).toBeVisible();
    await page.getByTestId('field-logic-condition-source').click();
    await page.getByRole('option', { name: 'second' }).click();

    await expect(page.getByTestId('field-logic-errors')).toContainText('part of a loop');
    await page.waitForTimeout(2_000);
    await expect(page.getByText('Save failed')).toHaveCount(0);
    await expect(page.getByText('Sync failed, changes not saved')).toHaveCount(0);

    const stored = await prisma.field.findUniqueOrThrow({ where: { id: firstField.id } });

    expect((stored.fieldMeta as { condition?: unknown }).condition).toBeUndefined();
  });

  test('a duplicate field key is reported once, in the editor and by the API', async ({ page, request }) => {
    const { envelope, token, user, team } = await apiSeedDraftDocument(request, {
      recipients: [{ email: 'conditional-dupkey@test.documenso.com', name: 'Dup' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 30,
            height: 6,
            fieldMeta: { type: 'text', label: 'First', fieldKey: 'company' },
          },
          {
            type: FieldType.TEXT,
            page: 1,
            positionX: 40,
            positionY: 40,
            width: 30,
            height: 6,
            fieldMeta: { type: 'text', label: 'Second' },
          },
        ],
      ],
    });

    const sentence = 'The field key "company" is used by more than one field.';

    const apiRefusal = await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        envelopeId: envelope.id,
        data: [
          {
            recipientId: envelope.recipients[0].id,
            envelopeItemId: envelope.envelopeItems[0].id,
            type: FieldType.TEXT,
            page: 1,
            positionX: 60,
            positionY: 60,
            width: 10,
            height: 5,
            fieldMeta: { type: 'text', fieldKey: 'company' },
          },
        ],
      },
    });

    expect(apiRefusal.status()).toBe(400);

    const { message } = (await apiRefusal.json()) as { message: string };

    expect(message.split(sentence).length - 1).toBe(1);

    await openEditorAndSelectField(
      page,
      `/t/${team.url}/documents/${envelope.id}/edit?step=addFields`,
      user.email,
      findField(envelope, 'Second'),
    );

    await page.getByTestId('field-logic-expand').click();
    await page.getByTestId('field-logic-key').fill('company');

    await expect(page.getByTestId('field-logic-errors')).toContainText(sentence);
    await expect(page.getByTestId('field-logic-errors').getByText(sentence)).toHaveCount(1);
  });

  test('a template that uses conditions can get a direct link, which becomes a public form', async ({ request }) => {
    const { envelope, token } = await apiSeedTemplate(request, {
      recipients: [{ email: 'conditional-direct@test.documenso.com', name: 'Direct', role: 'SIGNER' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
          {
            type: FieldType.CHECKBOX,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 20,
            height: 5,
            fieldMeta: CHECKBOX_META,
          },
        ],
      ],
    });

    const response = await request.post(`${API_BASE_URL}/template/direct/create`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { templateId: mapSecondaryIdToTemplateId(envelope.secondaryId) },
    });

    expect(response.ok(), await response.text()).toBe(true);

    const directLink = await prisma.templateDirectLink.findUniqueOrThrow({
      where: { envelopeId: envelope.id },
      include: { stPublicForm: true },
    });

    expect(directLink.stPublicForm?.requireVerifiedEmail).toBe(true);
  });
});

type EnvelopeField = TGetEnvelopeResponse['fields'][number];

const openEditorAndSelectField = async (page: Page, redirectPath: string, email: string, field: EnvelopeField) => {
  await apiSignin({ page, email, redirectPath });

  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);

  const canvasBox = await getCanvasBox(page);

  await getPageCanvas(page).click({
    force: true,
    position: {
      x: ((Number(field.positionX) + Number(field.width) / 2) / 100) * canvasBox.width,
      y: ((Number(field.positionY) + Number(field.height) / 2) / 100) * canvasBox.height,
    },
  });
};

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

const expectOk = async (response: Promise<Awaited<ReturnType<APIRequestContext['post']>>>) => {
  const resolved = await response;

  expect(resolved.ok(), await resolved.text()).toBe(true);

  return resolved;
};

const openSigningPage = async (page: Page, token: string) => {
  await page.goto(`/sign/${token}`);

  await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 30_000 });
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });
};

const isFieldOnCanvas = async (page: Page, fieldId: number) =>
  await page.evaluate((fieldId) => {
    const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;
    const stage = konva.stages.find((candidate) => candidate.attrs.id === 'page-1');

    return Boolean(stage?.findOne(`#${fieldId}`));
  }, fieldId);

const clickField = async (page: Page, field: EnvelopeField) => {
  const canvasBox = await getCanvasBox(page);

  await getPageCanvas(page).click({
    position: {
      x: ((Number(field.positionX) + Number(field.width) / 2) / 100) * canvasBox.width,
      y: ((Number(field.positionY) + Number(field.height) / 2) / 100) * canvasBox.height,
    },
  });
};

const fillTextField = async (page: Page, field: EnvelopeField, value: string) => {
  const dialog = page.getByRole('dialog');

  await clickField(page, field);
  await dialog.locator('#custom-text').fill(value);
  await dialog.getByRole('button', { name: 'Enter' }).click();
  await expect.poll(() => getKonvaFieldTextForPage(page, 1, field.id)).toBe(value);
};
