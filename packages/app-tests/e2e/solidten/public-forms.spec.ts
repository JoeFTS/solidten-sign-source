import fs from 'node:fs';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import {
  publicFormOpenRateLimit,
  publicFormSubmitRateLimit,
} from '@documenso/lib/server-only/public-form/public-form-rate-limits';
import { preparePublicFormSubmission } from '@documenso/lib/server-only/public-form/public-form-submit';
import { getBucket, parseWindow } from '@documenso/lib/server-only/rate-limit/rate-limit';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { createPublicFormOpenedToken, generatePublicFormCode } from '@documenso/lib/utils/public-form';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, type Prisma, RecipientRole } from '@prisma/client';
import type Konva from 'konva';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { getKonvaFieldTextForPage } from '../fixtures/konva';
import { signSignaturePad } from '../fixtures/signature';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const ENCRYPTION_KEY = process.env.NEXT_PRIVATE_ENCRYPTION_KEY ?? '';

// The submit and code limits are per IP. Every test gets its own address, so tests never
// share a rate limit bucket, also when rate limits are on.
let ipCounter = Math.floor(Math.random() * 200);
// seedTestEmail() can start an address with "-", which the email schema refuses.
const formEmail = () => `form-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@test.documenso.com`;

const nextIp = () => `198.51.${Math.floor(Math.random() * 250)}.${(ipCounter++ % 250) + 1}`;

test.describe.configure({ mode: 'parallel' });

test.describe('Solid Ten public forms', () => {
  test('a visitor verifies the email with a code and submits the form', async ({ page }) => {
    const { template, form, signatureField } = await seedPublicForm({
      introText: 'Please fill in the membership form.',
      thankYouMessage: 'Thanks, we will be in touch.',
    });
    const email = formEmail();
    const ip = nextIp();

    await page.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
    await page.goto(formatDirectTemplatePath(template.directLink.token));

    await expect(page.getByTestId('public-form-verify-email')).toBeVisible();
    await expect(page.getByText('Please fill in the membership form.')).toBeVisible();

    // Typing before hydration would be wiped when React takes over the input.
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Email address').fill(email);
    await expect(page.getByLabel('Email address')).toHaveValue(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible({ timeout: 20_000 });

    await page.getByLabel('Verification code').fill(await codeFor(form.id, email));
    await page.getByRole('button', { name: 'Confirm code' }).click();

    await expect(page.getByTestId('public-form-intro')).toHaveText('Please fill in the membership form.');
    const pageOpenedAt = Date.now();

    await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 30_000 });
    const canvas = page.locator('.konva-container canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    await signSignaturePad(page);
    await clickFieldOnCanvas(page, signatureField);
    await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });

    // The server refuses a submission made within 5 seconds of the page load.
    await page.waitForTimeout(Math.max(0, 6_000 - (Date.now() - pageOpenedAt)));

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByRole('button', { name: 'Sign' }).click();

    await page.waitForURL(/\/sign\/.+\/complete/);
    await expect(page.getByTestId('public-form-thank-you')).toHaveText('Thanks, we will be in touch.');

    const submission = await prisma.stPublicFormSubmission.findFirstOrThrow({ where: { formId: form.id } });

    expect(submission.submitterEmail).toBe(email);
    expect(submission.emailVerified).toBe(true);
    expect(submission.ipAddress).toBe(ip);

    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: submission.envelopeId } });
    expect(recipient.email).toBe(email);

    const auditLog = await prisma.documentAuditLog.findFirstOrThrow({
      where: { envelopeId: submission.envelopeId, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_PUBLIC_FORM_SUBMITTED },
    });
    expect(auditLog.data).toMatchObject({ emailVerified: true, submitterEmail: email, recipientId: recipient.id });
    expect(auditLog.ipAddress).toBe(ip);

    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).submissionCount).toBe(1);
  });

  test('conditional and calculated fields work on a public form page', async ({ page }) => {
    const { template, form, signatureField } = await seedPublicForm({ requireVerifiedEmail: false });

    const company = await addField(template, {
      type: FieldType.TEXT,
      positionY: 20,
      fieldMeta: { type: 'text', label: 'Company', fieldKey: 'company' },
    });
    const vat = await addField(template, {
      type: FieldType.TEXT,
      positionY: 30,
      fieldMeta: {
        type: 'text',
        label: 'VAT',
        required: true,
        condition: { fieldKey: 'company', operator: 'notEmpty' },
      },
    });
    const price = await addField(template, {
      type: FieldType.NUMBER,
      positionY: 40,
      fieldMeta: { type: 'number', label: 'Price', fieldKey: 'price' },
    });
    const quantity = await addField(template, {
      type: FieldType.NUMBER,
      positionY: 50,
      fieldMeta: { type: 'number', label: 'Quantity', fieldKey: 'quantity' },
    });
    const total = await addField(template, {
      type: FieldType.NUMBER,
      positionY: 60,
      fieldMeta: { type: 'number', label: 'Total', formula: '{{price}} * {{quantity}}' },
    });

    await page.setExtraHTTPHeaders({ 'x-forwarded-for': nextIp() });
    await page.goto(formatDirectTemplatePath(template.directLink.token));
    const pageOpenedAt = Date.now();

    await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => isFieldOnCanvas(page, vat.id)).toBe(false);

    await signSignaturePad(page);
    await clickFieldOnCanvas(page, signatureField);

    await fillCanvasField(page, price, '12.5');
    await fillCanvasField(page, quantity, '3');
    await expect.poll(() => getKonvaFieldTextForPage(page, 1, total.id)).toBe('37.5');

    await fillCanvasField(page, company, 'Acme');
    await expect.poll(() => isFieldOnCanvas(page, vat.id)).toBe(true);
    await fillCanvasField(page, vat, 'NL123');

    await page.waitForTimeout(Math.max(0, 6_000 - (Date.now() - pageOpenedAt)));

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByPlaceholder('Enter Your Name').fill('Form Visitor');
    await page.getByPlaceholder('Enter Your Email').fill(formEmail());
    await page.getByRole('button', { name: 'Sign' }).click();
    await page.waitForURL(/\/sign\/.+\/complete/);

    const submission = await prisma.stPublicFormSubmission.findFirstOrThrow({ where: { formId: form.id } });
    expect(submission.emailVerified).toBe(false);

    const created = await prisma.field.findMany({ where: { envelopeId: submission.envelopeId } });
    const byLabel = (label: string) => created.find((field) => (field.fieldMeta as { label?: string }).label === label);

    expect([byLabel('Total')?.customText, byLabel('Total')?.inserted]).toEqual(['37.5', true]);
    expect([byLabel('VAT')?.customText, byLabel('VAT')?.inserted]).toEqual(['NL123', true]);

    // No mail goes to an address the form did not verify (Solid Ten Sign, AUD-C4 follow-up: only
    // that recipient is marked; the owner's recipients and notices are unchanged).
    const submitter = await prisma.recipient.findFirstOrThrow({
      where: { envelopeId: submission.envelopeId, email: submission.submitterEmail.toLowerCase() },
    });
    expect(submitter.unverifiedEmailAt).not.toBeNull();
  });

  // RT1-H1: a calculated field in any number format must not block the submission.
  for (const [numberFormat, hours, expectedTotal] of [
    [null, '1234.5', '2469'],
    ['123,456,789.00', '1,234.5', '2,469.00'],
    ['123.456.789,00', '1.234,5', '2.469,00'],
    ['123456,789.00', '1234,567.5', '2469135.00'],
  ] as const) {
    test(`a form with a calculated field in format ${numberFormat ?? 'none'} can be submitted`, async ({ page }) => {
      const { template, form, signatureField } = await seedPublicForm({ requireVerifiedEmail: false });

      const hoursField = await addField(template, {
        type: FieldType.NUMBER,
        positionY: 20,
        fieldMeta: { type: 'number', label: 'Hours', fieldKey: 'hours', numberFormat },
      });
      await addField(template, {
        type: FieldType.NUMBER,
        positionY: 30,
        fieldMeta: { type: 'number', label: 'Total', formula: '{{hours}} * 2', numberFormat },
      });

      await page.setExtraHTTPHeaders({ 'x-forwarded-for': nextIp() });
      await page.goto(formatDirectTemplatePath(template.directLink.token));
      const pageOpenedAt = Date.now();

      await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });

      await signSignaturePad(page);
      await clickFieldOnCanvas(page, signatureField);
      await fillCanvasField(page, hoursField, hours);

      await page.waitForTimeout(Math.max(0, 6_000 - (Date.now() - pageOpenedAt)));

      await page.getByRole('button', { name: 'Complete' }).click();
      await page.getByPlaceholder('Enter Your Name').fill('Form Visitor');
      await page.getByPlaceholder('Enter Your Email').fill(formEmail());
      await page.getByRole('button', { name: 'Sign' }).click();
      await page.waitForURL(/\/sign\/.+\/complete/);

      const submission = await prisma.stPublicFormSubmission.findFirstOrThrow({ where: { formId: form.id } });
      const created = await prisma.field.findMany({ where: { envelopeId: submission.envelopeId } });
      const total = created.find((field) => (field.fieldMeta as { label?: string }).label === 'Total');

      expect([total?.customText, total?.inserted]).toEqual([expectedTotal, true]);
    });
  }

  test('a refused form submission tells the visitor why', async ({ page }) => {
    const { template, signatureField } = await seedPublicForm({ requireVerifiedEmail: false });

    const hoursField = await addField(template, {
      type: FieldType.NUMBER,
      positionY: 20,
      fieldMeta: { type: 'number', label: 'Hours', fieldKey: 'hours', numberFormat: '123456,789.00' },
    });

    // The page never sends a malformed number; rewrite the request to see what the visitor
    // is told when the server refuses one.
    await page.route('**/api/trpc/template.createDocumentFromDirectTemplate**', async (route) => {
      const body = route.request().postData() ?? '';

      await route.continue({ postData: body.replace('"value":"1234,567"', '"value":"1234,5"') });
    });

    await page.setExtraHTTPHeaders({ 'x-forwarded-for': nextIp() });
    await page.goto(formatDirectTemplatePath(template.directLink.token));
    const pageOpenedAt = Date.now();

    await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });

    await signSignaturePad(page);
    await clickFieldOnCanvas(page, signatureField);
    await fillCanvasField(page, hoursField, '1234,567');

    await page.waitForTimeout(Math.max(0, 6_000 - (Date.now() - pageOpenedAt)));

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByPlaceholder('Enter Your Name').fill('Form Visitor');
    await page.getByPlaceholder('Enter Your Email').fill(formEmail());
    await page.getByRole('button', { name: 'Sign' }).click();

    await expect(page.getByText('does not match the number format 123456,789.00').first()).toBeVisible();
    expect(await countDocumentsFromTemplate(template)).toBe(0);
  });

  for (const [state, update, reason] of [
    ['closed', { closedAt: new Date() }, 'This form is closed.'],
    ['full', { maxSubmissions: 1, submissionCount: 1 }, 'This form has reached its maximum number of responses.'],
  ] as const) {
    test(`a form that became ${state} while open says so, not "try again later"`, async ({ page }) => {
      const { template, form, signatureField } = await seedPublicForm({ requireVerifiedEmail: false });

      await page.setExtraHTTPHeaders({ 'x-forwarded-for': nextIp() });
      await page.goto(formatDirectTemplatePath(template.directLink.token));
      const pageOpenedAt = Date.now();

      await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });

      await signSignaturePad(page);
      await clickFieldOnCanvas(page, signatureField);

      // The sender closes the form, or it fills up, while the visitor is on the page.
      await prisma.stPublicForm.update({ where: { id: form.id }, data: update });

      await page.waitForTimeout(Math.max(0, 6_000 - (Date.now() - pageOpenedAt)));

      await page.getByRole('button', { name: 'Complete' }).click();
      await page.getByPlaceholder('Enter Your Name').fill('Form Visitor');
      await page.getByPlaceholder('Enter Your Email').fill(formEmail());
      await page.getByRole('button', { name: 'Sign' }).click();

      await expect(page.getByText(reason).first()).toBeVisible();
      await expect(page.getByText('Please try again later')).toHaveCount(0);
      expect(await countDocumentsFromTemplate(template)).toBe(0);
    });
  }

  test('a wrong code is refused and five wrong codes lock the address', async ({ request }) => {
    const { template, form } = await seedPublicForm();
    const email = formEmail();
    const ip = nextIp();
    const token = template.directLink.token;
    const rightCode = await codeFor(form.id, email);
    const wrongCode = rightCode === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await trpc(request, 'publicForm.verifyCode', { token, email, code: wrongCode }, { ip });

      expect(response.status()).toBe(400);
      expect(await response.text()).toContain('The code is not correct.');
    }

    const fifth = await trpc(request, 'publicForm.verifyCode', { token, email, code: wrongCode }, { ip });
    expect(await fifth.text()).toContain('Too many wrong codes');

    const locked = await trpc(request, 'publicForm.verifyCode', { token, email, code: rightCode }, { ip });
    expect(locked.status()).toBe(429);
    expect(await locked.text()).not.toContain('proof');
    // Solid Ten (LD3-L1): the lock says when it ends, in the tRPC 429 shape.
    expect(Number(locked.headers()['retry-after'])).toBeGreaterThan(0);
    expect(Number(locked.headers()['retry-after'])).toBeLessThanOrEqual(15 * 60);
    expect((await locked.json()).error.json.code).toBe(-32029);

    const otherEmail = formEmail();
    const other = await trpc(
      request,
      'publicForm.verifyCode',
      { token, email: otherEmail, code: await codeFor(form.id, otherEmail) },
      { ip },
    );
    expect(other.ok(), await other.text()).toBe(true);
  });

  test('field rules are enforced on the server and a tampered submission is refused', async ({ request }) => {
    const { template, form, signatureField } = await seedPublicForm();
    const fields = await addRuleFields(template);
    const email = formEmail();
    const ip = nextIp();
    const proof = await verifyEmail(request, template.directLink.token, form.id, email, ip);

    const values = (overrides: Record<number, string>) =>
      [
        { fieldId: signatureField.id, value: 'Ann Signer' },
        { fieldId: fields.agree.id, value: '[0]' },
        { fieldId: fields.details.id, value: 'Extra details' },
        { fieldId: fields.price.id, value: '2.5' },
        { fieldId: fields.quantity.id, value: '4' },
        { fieldId: fields.total.id, value: '10' },
      ].map((value) => ({ ...value, value: overrides[value.fieldId] ?? value.value }));

    const hiddenValue = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      signedFieldValues: values({ [fields.agree.id]: '' }),
    });
    expect(await hiddenValue.text()).toContain('HIDDEN_FIELD_HAS_VALUE');

    const changedTotal = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      signedFieldValues: values({ [fields.total.id]: '999' }),
    });
    expect(await changedTotal.text()).toContain('CALCULATED_VALUE_CHANGED');

    const emptyRequired = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      signedFieldValues: values({ [fields.details.id]: '' }),
    });
    expect(await emptyRequired.text()).toContain('CONDITIONAL_FIELD_EMPTY');

    const noProof = await submit(request, template, { email, ip, signedFieldValues: values({}) });
    expect(await noProof.text()).toContain('Verify your email address');

    const otherEmailsProof = await submit(request, template, {
      email: formEmail(),
      ip,
      verifiedProof: proof,
      signedFieldValues: values({}),
    });
    expect(await otherEmailsProof.text()).toContain('Verify your email address');

    const tooFast = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      openedToken: createPublicFormOpenedToken({ key: ENCRYPTION_KEY, formId: form.id, now: new Date() }),
      signedFieldValues: values({}),
    });
    expect(await tooFast.text()).toContain('submitted too quickly');

    const honeypot = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      honeypot: 'https://spam.example',
      signedFieldValues: values({}),
    });
    expect(await honeypot.text()).toContain('The submission was refused');

    expect(await countDocumentsFromTemplate(template)).toBe(0);
    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).submissionCount).toBe(0);

    // The calculated value is left out: the server computes it.
    const honest = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      signedFieldValues: values({}).filter((value) => value.fieldId !== fields.total.id),
    });
    expect(honest.ok(), await honest.text()).toBe(true);

    const envelope = await prisma.envelope.findFirstOrThrow({
      where: { templateId: mapSecondaryIdToTemplateId(template.secondaryId) },
      include: { fields: true },
    });

    const storedTotal = envelope.fields.find(
      (field) => (field.fieldMeta as { formula?: string } | null)?.formula !== undefined,
    );
    expect(storedTotal?.customText).toBe('10');
    expect(storedTotal?.inserted).toBe(true);

    expect(
      await prisma.documentAuditLog.count({
        where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_CALCULATED },
      }),
    ).toBe(1);

    // The server's value is recorded before the visitor completes, and the visitor is not
    // recorded as filling the calculated field.
    const auditLogs = await prisma.documentAuditLog.findMany({
      where: { envelopeId: envelope.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const types = auditLogs.map((auditLog) => auditLog.type);

    expect(types.indexOf(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_CALCULATED)).toBeLessThan(
      types.indexOf(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED),
    );
    expect(
      auditLogs.filter(
        (auditLog) =>
          auditLog.type === DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED &&
          (auditLog.data as { fieldId?: string }).fieldId === storedTotal?.secondaryId,
      ),
    ).toEqual([]);
  });

  test('a closed form and a form that is not open yet refuse visitors and submissions', async ({ page, request }) => {
    const { template, form, signatureField } = await seedPublicForm({
      requireVerifiedEmail: false,
      closesAt: new Date(Date.now() - 60_000),
    });

    await page.setExtraHTTPHeaders({ 'x-forwarded-for': nextIp() });
    await page.goto(formatDirectTemplatePath(template.directLink.token));
    await expect(page.getByTestId('public-form-unavailable')).toContainText('This form is closed.');
    await expect(page.locator('img[data-page-number]')).toHaveCount(0);

    const closed = await submit(request, template, {
      email: formEmail(),
      ip: nextIp(),
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });
    expect(await closed.text()).toContain('This form is closed.');

    await prisma.stPublicForm.update({
      where: { id: form.id },
      data: { closesAt: null, opensAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });

    await page.reload();
    await expect(page.getByTestId('public-form-unavailable')).toContainText('This form opens on');

    const notOpen = await submit(request, template, {
      email: formEmail(),
      ip: nextIp(),
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });
    expect(await notOpen.text()).toContain('This form is not open yet.');
    expect(await countDocumentsFromTemplate(template)).toBe(0);
  });

  test('concurrent submissions against a cap of one create exactly one document', async ({ request }) => {
    const { template, form, signatureField } = await seedPublicForm({ requireVerifiedEmail: false, maxSubmissions: 1 });

    const responses = await Promise.all(
      Array.from({ length: 6 }).map(async () =>
        submit(request, template, {
          email: formEmail(),
          ip: nextIp(),
          signedFieldValues: [{ fieldId: signatureField.id, value: 'Racer' }],
        }),
      ),
    );

    const accepted = responses.filter((response) => response.ok());
    expect(accepted).toHaveLength(1);

    for (const response of responses.filter((candidate) => !candidate.ok())) {
      expect(await response.text()).toContain('maximum number of responses');
    }

    expect(await countDocumentsFromTemplate(template)).toBe(1);
    expect(await prisma.stPublicFormSubmission.count({ where: { formId: form.id } })).toBe(1);
    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).submissionCount).toBe(1);
  });

  test('a crash between the checks and the document leaves the slot free', async () => {
    const { template, form } = await seedPublicForm({ requireVerifiedEmail: false, maxSubmissions: 1 });

    // Every check passes and a slot would be taken; then the process dies before the
    // document exists (the reviewer killed the app 0.6 s into the submits).
    const prepared = await preparePublicFormSubmission({
      directTemplateToken: template.directLink.token,
      directRecipientEmail: formEmail(),
      hasNextSigner: false,
      publicForm: {
        openedToken: createPublicFormOpenedToken({
          key: ENCRYPTION_KEY,
          formId: form.id,
          now: new Date(Date.now() - 10_000),
        }),
        honeypot: '',
      },
      requestMetadata: { ipAddress: nextIp(), userAgent: 'crash-test' },
    });
    expect(prepared).not.toBeNull();

    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).submissionCount).toBe(0);
  });

  test('concurrent submissions against a cap of one still create exactly one document (20 at once)', async ({
    request,
  }) => {
    const { template, form, signatureField } = await seedPublicForm({ requireVerifiedEmail: false, maxSubmissions: 1 });

    const responses = await Promise.all(
      Array.from({ length: 20 }).map(async () =>
        submit(request, template, {
          email: formEmail(),
          ip: nextIp(),
          signedFieldValues: [{ fieldId: signatureField.id, value: 'Racer' }],
        }),
      ),
    );

    expect(responses.filter((response) => response.ok())).toHaveLength(1);
    expect(await countDocumentsFromTemplate(template)).toBe(1);
    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).submissionCount).toBe(1);
  });

  test('the submit rate limit trips after ten submissions from one IP', async () => {
    const formId = `rate-limit-${Date.now()}`;
    const ip = nextIp();
    const bypass = process.env.DANGEROUS_BYPASS_RATE_LIMITS;

    // Checks the limiter itself, so the test holds where the server runs with rate limits bypassed.
    process.env.DANGEROUS_BYPASS_RATE_LIMITS = 'false';

    try {
      for (let index = 0; index < 10; index++) {
        expect((await publicFormSubmitRateLimit.check({ ip, identifier: formId })).isLimited).toBe(false);
      }

      expect((await publicFormSubmitRateLimit.check({ ip, identifier: formId })).isLimited).toBe(true);
      expect((await publicFormSubmitRateLimit.check({ ip: nextIp(), identifier: formId })).isLimited).toBe(false);

      const openIp = nextIp();

      for (let index = 0; index < 60; index++) {
        await publicFormOpenRateLimit.check({ ip: openIp, identifier: formId });
      }

      expect((await publicFormOpenRateLimit.check({ ip: openIp, identifier: formId })).isLimited).toBe(true);
    } finally {
      process.env.DANGEROUS_BYPASS_RATE_LIMITS = bypass;
    }
  });

  test('the form routes refuse an IP that is over its limit', async ({ page, request }) => {
    test.skip(
      process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true',
      'The server bypasses rate limits; the limiter test above covers them.',
    );

    const { template, form, signatureField } = await seedPublicForm({ requireVerifiedEmail: false });
    const ip = nextIp();

    await fillRateLimitBucket({ ip, action: 'st.form.submit', window: '1h', count: 10 });
    await fillRateLimitBucket({ ip, action: 'st.form.open', window: '10m', count: 60 });

    const limited = await submit(request, template, {
      email: formEmail(),
      ip,
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });
    expect(limited.status()).toBe(429);
    expect(await prisma.stPublicFormSubmission.count({ where: { formId: form.id } })).toBe(0);

    await page.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
    const opened = await page.goto(formatDirectTemplatePath(template.directLink.token));
    expect(opened?.status()).toBe(429);
  });

  test('the sender sees responses, filters them, exports a safe CSV and closes the form', async ({ page, request }) => {
    const { user, team, template, form, signatureField } = await seedPublicForm({ requireVerifiedEmail: false });
    const plainEmail = formEmail();
    const formulaEmail = formEmail();

    for (const [email, name] of [
      [plainEmail, 'Plain Person'],
      [formulaEmail, '=HYPERLINK("https://evil.example","x")'],
      // S-L3: a reader set to ";" would split this into "Bob" and a formula.
      [formEmail(), 'Bob;=1+1'],
    ]) {
      const response = await submit(request, template, {
        email,
        name,
        ip: nextIp(),
        signedFieldValues: [{ fieldId: signatureField.id, value: 'Signer' }],
      });
      expect(response.ok(), await response.text()).toBe(true);
    }

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/templates/${template.id}` });

    const panel = page.getByTestId('public-form-panel');
    await expect(panel.getByTestId('public-form-count')).toContainText('3 responses');
    await expect(panel.getByTestId('public-form-status')).toHaveText('Open');
    await expect(panel.getByTestId('public-form-responses')).toContainText(plainEmail);
    await expect(panel.getByTestId('public-form-responses')).toContainText(formulaEmail);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await panel.getByLabel('From').fill(tomorrow);
    await expect(panel.getByTestId('public-form-responses')).toContainText('No responses yet');
    await panel.getByLabel('From').fill('');
    await expect(panel.getByTestId('public-form-responses')).toContainText(plainEmail);

    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    const csv = fs.readFileSync(await download.path(), 'utf8');

    expect(csv).toContain(plainEmail);
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csv).toContain(`"Bob;'=1+1"`);
    expect(csv).not.toMatch(/[,;]=1\+1/);

    await panel.getByRole('button', { name: 'Close form' }).click();
    await expect(panel.getByTestId('public-form-status')).toHaveText('Closed');
    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).closedAt).not.toBeNull();

    await page.goto(formatDirectTemplatePath(template.directLink.token));
    await expect(page.getByTestId('public-form-unavailable')).toContainText('This form is closed.');
  });

  test('a form without email verification cannot send email to other recipients', async ({ page, request }) => {
    const { user, team, template, form, signatureField } = await seedPublicForm();

    const other = await prisma.recipient.create({
      data: {
        envelopeId: template.id,
        email: formEmail(),
        name: 'Second Signer',
        role: RecipientRole.SIGNER,
        signingOrder: 2,
        token: `other-${Date.now()}`,
      },
    });
    await addField(template, {
      recipientId: other.id,
      type: FieldType.SIGNATURE,
      positionY: 40,
      fieldMeta: { type: 'signature' },
    });

    await apiSignin({ page, email: user.email });

    const refused = await trpc(
      page.context().request,
      'publicForm.updateSettings',
      {
        envelopeId: template.id,
        data: {
          opensAt: null,
          closesAt: null,
          maxSubmissions: null,
          introText: null,
          thankYouMessage: null,
          redirectUrl: null,
          requireVerifiedEmail: false,
        },
      },
      { teamId: team.id },
    );
    expect(refused.ok()).toBe(false);
    expect(await refused.text()).toContain('must verify the email address');
    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).requireVerifiedEmail).toBe(true);

    // Settings saved before the recipient was added must not open a way around the rule.
    await prisma.stPublicForm.update({ where: { id: form.id }, data: { requireVerifiedEmail: false } });

    const submitted = await submit(request, template, {
      email: formEmail(),
      ip: nextIp(),
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });
    expect(await submitted.text()).toContain('must verify your email address');
    expect(await countDocumentsFromTemplate(template)).toBe(0);
  });
});

test.describe('Solid Ten public forms: S-H3 relay protections', () => {
  const seedRelayForm = async () => {
    const seeded = await seedPublicForm();
    const { template } = seeded;

    // The reviewer's setup: sequential order, next-signer dictation on, a second signer.
    const other = await prisma.recipient.create({
      data: {
        envelopeId: template.id,
        email: formEmail(),
        name: 'Counter Signer',
        role: RecipientRole.SIGNER,
        signingOrder: 2,
        token: `relay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    await addField(template, {
      recipientId: other.id,
      type: FieldType.SIGNATURE,
      positionY: 40,
      fieldMeta: { type: 'signature' },
    });

    const { documentMetaId } = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });
    await prisma.documentMeta.update({
      where: { id: documentMetaId },
      data: { allowDictateNextSigner: true, signingOrder: 'SEQUENTIAL' },
    });
    await prisma.recipient.update({
      where: { id: template.directLink.directTemplateRecipientId },
      data: { signingOrder: 1 },
    });

    return { ...seeded, other };
  };

  const submitWithNextSigner = async (
    request: APIRequestContext,
    template: SeededTemplate,
    options: { email: string; ip: string; proof: string; fieldId: number; formId: string; victim: string },
  ) => {
    const { updatedAt } = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });

    return await trpc(
      request,
      'template.createDocumentFromDirectTemplate',
      {
        directTemplateToken: template.directLink.token,
        directRecipientEmail: options.email,
        directRecipientName: 'Attacker',
        templateUpdatedAt: updatedAt.toISOString(),
        signedFieldValues: [{ token: '', isBase64: false, fieldId: options.fieldId, value: 'Attacker' }],
        nextSigner: { email: options.victim, name: 'Your bank: urgent action' },
        publicForm: {
          openedToken: createPublicFormOpenedToken({
            key: ENCRYPTION_KEY,
            formId: options.formId,
            now: new Date(Date.now() - 10_000),
          }),
          verifiedProof: options.proof,
          honeypot: '',
        },
      },
      { ip: options.ip, meta: { values: { templateUpdatedAt: ['Date'] } } },
    );
  };

  test('a verified form refuses a next signer', async ({ request }) => {
    const { template, form, signatureField } = await seedRelayForm();
    const email = formEmail();
    const ip = nextIp();
    const proof = await verifyEmail(request, template.directLink.token, form.id, email, ip);
    const victim = `victim-${Date.now()}-${Math.random().toString(36).slice(2)}@innocent.test`;

    const response = await submitWithNextSigner(request, template, {
      victim,
      email,
      ip,
      proof,
      fieldId: signatureField.id,
      formId: form.id,
    });

    expect(response.ok()).toBe(false);
    expect(await response.text()).toContain('cannot send the document on to another person');
    expect(await countDocumentsFromTemplate(template)).toBe(0);
    expect(await prisma.recipient.count({ where: { email: victim } })).toBe(0);
  });

  test('one email verification creates one document', async ({ request }) => {
    const { template, form, signatureField } = await seedPublicForm();
    const email = formEmail();
    const ip = nextIp();
    const proof = await verifyEmail(request, template.directLink.token, form.id, email, ip);

    const first = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });
    expect(first.ok(), await first.text()).toBe(true);

    const second = await submit(request, template, {
      email,
      ip: nextIp(),
      verifiedProof: proof,
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });
    expect(second.ok()).toBe(false);
    expect(await second.text()).toContain('already used');

    expect(await countDocumentsFromTemplate(template)).toBe(1);
    expect((await prisma.stPublicForm.findUniqueOrThrow({ where: { id: form.id } })).submissionCount).toBe(1);
  });

  test('a form has a daily cap on emails to people other than the submitter', async ({ request }) => {
    const { template, form, signatureField } = await seedRelayForm();

    // Today's counter at the default cap of 100.
    const now = Date.now();
    const bucket = new Date(now - (now % (24 * 60 * 60 * 1000)));
    await prisma.rateLimit.create({
      data: { key: `form:${form.id}`, action: 'st.public-form.other-emails', bucket, count: 100 },
    });

    const email = formEmail();
    const ip = nextIp();
    const proof = await verifyEmail(request, template.directLink.token, form.id, email, ip);

    const response = await submit(request, template, {
      email,
      ip,
      verifiedProof: proof,
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });

    expect(response.ok()).toBe(false);
    expect(await response.text()).toContain('limit for today');
    expect(await countDocumentsFromTemplate(template)).toBe(0);
  });
});

test.describe('Solid Ten public forms: S-M6 code email limits', () => {
  const requestCode = async (
    request: APIRequestContext,
    template: SeededTemplate,
    formId: string,
    options: { email: string; ip: string; openedToken?: string | null },
  ) =>
    await trpc(
      request,
      'publicForm.requestCode',
      {
        token: template.directLink.token,
        email: options.email,
        honeypot: '',
        ...(options.openedToken === null
          ? {}
          : {
              openedToken:
                options.openedToken ??
                createPublicFormOpenedToken({ key: ENCRYPTION_KEY, formId, now: new Date(Date.now() - 1_000) }),
            }),
      },
      { ip: options.ip },
    );

  test('a code needs the opened form page, and each form has a daily cap', async ({ request }) => {
    const { template, form } = await seedPublicForm();

    // No opened-form token: refused, nothing sent.
    const blind = await requestCode(request, template, form.id, {
      email: formEmail(),
      ip: nextIp(),
      openedToken: null,
    });
    expect(blind.ok()).toBe(false);
    expect(await blind.text()).toContain('This page has expired');

    const forged = await requestCode(request, template, form.id, {
      email: formEmail(),
      ip: nextIp(),
      openedToken: `${Date.now()}.deadbeef`,
    });
    expect(forged.ok()).toBe(false);

    const allowed = await requestCode(request, template, form.id, { email: formEmail(), ip: nextIp() });
    expect(allowed.ok(), await allowed.text()).toBe(true);

    // Today's counter for this form at the default cap of 200.
    const now = Date.now();
    const bucket = new Date(now - (now % (24 * 60 * 60 * 1000)));
    await prisma.rateLimit.update({
      where: { key_action_bucket: { key: `form:${form.id}`, action: 'st.public-form.code-emails', bucket } },
      data: { count: 200 },
    });

    const capped = await requestCode(request, template, form.id, { email: formEmail(), ip: nextIp() });
    expect(capped.ok()).toBe(false);
    expect(await capped.text()).toContain('too many codes today');
  });

  test('the form settings card warns when bot protection is not set up', async ({ page }) => {
    const { user, team, template } = await seedPublicForm();

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/templates/${template.id}` });

    await expect(page.getByTestId('public-form-captcha-warning')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('public-form-captcha-warning')).toContainText('Bot protection');
  });
});

test.describe('Solid Ten public forms: RT4-M3 no dead end after a used code', () => {
  const generationFor = async (formId: string, email: string) => {
    const rows = await prisma.rateLimit.findMany({ where: { action: 'st.form.code-generation' } });
    const row = rows.find((candidate) => candidate.key.startsWith(`gen:${formId}:`));

    return row?.count ?? 0;
  };

  test('after a used code, the next request gives a fresh code that works once', async ({ request }) => {
    const { template, form, signatureField } = await seedPublicForm();
    const email = formEmail();

    const first = await verifyEmail(request, template.directLink.token, form.id, email, nextIp());
    const submitted = await submit(request, template, {
      email,
      ip: nextIp(),
      verifiedProof: first,
      signedFieldValues: [{ fieldId: signatureField.id, value: 'Ann' }],
    });
    expect(submitted.ok(), await submitted.text()).toBe(true);

    const openedToken = createPublicFormOpenedToken({ key: ENCRYPTION_KEY, formId: form.id, now: new Date() });
    const again = await trpc(
      request,
      'publicForm.requestCode',
      { token: template.directLink.token, email, honeypot: '', openedToken },
      { ip: nextIp() },
    );
    expect(again.ok(), await again.text()).toBe(true);

    const generation = await generationFor(form.id, email);
    expect(generation).toBe(1);

    const oldCode = await codeFor(form.id, email);
    const freshCode = await generatePublicFormCode({
      key: ENCRYPTION_KEY,
      formId: form.id,
      email,
      now: new Date(),
      generation,
    });
    expect(freshCode).not.toBe(oldCode);

    const withOld = await trpc(
      request,
      'publicForm.verifyCode',
      { token: template.directLink.token, email, code: oldCode },
      { ip: nextIp() },
    );
    expect(withOld.ok()).toBe(false);

    const withFresh = await trpc(
      request,
      'publicForm.verifyCode',
      { token: template.directLink.token, email, code: freshCode },
      { ip: nextIp() },
    );
    expect(withFresh.ok(), await withFresh.text()).toBe(true);

    const freshAgain = await trpc(
      request,
      'publicForm.verifyCode',
      { token: template.directLink.token, email, code: freshCode },
      { ip: nextIp() },
    );
    expect(freshAgain.ok()).toBe(false);
  });

  test('a verified visitor who reloads keeps the form without a new code', async ({ page }) => {
    const { template, form } = await seedPublicForm();
    const email = formEmail();

    await page.setExtraHTTPHeaders({ 'x-forwarded-for': nextIp() });
    await page.goto(formatDirectTemplatePath(template.directLink.token));
    await expect(page.getByTestId('public-form-verify-email')).toBeVisible();

    await page.waitForLoadState('networkidle');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Verification code').fill(await codeFor(form.id, email));
    await page.getByRole('button', { name: 'Confirm code' }).click();
    await expect(page.getByTestId('public-form-verify-email')).toHaveCount(0, { timeout: 20_000 });

    const codeRequests = async () =>
      (
        await prisma.rateLimit.findMany({ where: { action: 'st.public-form.code-emails', key: `form:${form.id}` } })
      ).reduce((sum, row) => sum + row.count, 0);
    const before = await codeRequests();

    await page.reload();
    await page.waitForLoadState('networkidle');

    // Still verified: no code screen, and no second code email.
    await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('public-form-verify-email')).toHaveCount(0);
    expect(await codeRequests()).toBe(before);
  });
});

test.describe('Solid Ten public forms: RT1-M3 single-use codes', () => {
  test('one emailed code verifies once, also when verifies race', async ({ request }) => {
    const { template, form } = await seedPublicForm();
    const email = formEmail();
    const code = await codeFor(form.id, email);

    const verifies = await Promise.all(
      Array.from({ length: 8 }, async () =>
        trpc(request, 'publicForm.verifyCode', { token: template.directLink.token, email, code }, { ip: nextIp() }),
      ),
    );

    const accepted = verifies.filter((response) => response.ok());
    expect(accepted).toHaveLength(1);

    for (const refused of verifies.filter((response) => !response.ok())) {
      expect(await refused.text()).toContain('already used');
    }

    // Later, one at a time: still refused.
    const again = await trpc(
      request,
      'publicForm.verifyCode',
      { token: template.directLink.token, email, code },
      { ip: nextIp() },
    );
    expect(again.ok()).toBe(false);
  });
});

type SeededTemplate = Awaited<ReturnType<typeof seedDirectTemplate>> & {
  directLink: NonNullable<Awaited<ReturnType<typeof seedDirectTemplate>>['directLink']>;
};

const seedPublicForm = async (formData: Omit<Prisma.StPublicFormUncheckedCreateInput, 'directLinkId'> = {}) => {
  const { user, team } = await seedUser();

  const seeded = await seedDirectTemplate({
    title: `Public form ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });

  if (!seeded.directLink) {
    throw new Error('Seeded template has no direct link');
  }

  const template: SeededTemplate = { ...seeded, directLink: seeded.directLink };

  const form = await prisma.stPublicForm.create({
    data: { directLinkId: template.directLink.id, ...formData },
  });

  const signatureField = template.fields[0];

  return { user, team, template, form, signatureField };
};

const addField = async (
  template: SeededTemplate,
  {
    recipientId = template.directLink.directTemplateRecipientId,
    type,
    positionY,
    fieldMeta,
  }: { recipientId?: number; type: FieldType; positionY: number; fieldMeta: Record<string, unknown> },
) => {
  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

  return await prisma.field.create({
    data: {
      envelopeId: template.id,
      envelopeItemId: envelopeItem.id,
      recipientId,
      type,
      page: 1,
      positionX: 5,
      positionY,
      width: 20,
      height: 5,
      customText: '',
      inserted: false,
      fieldMeta,
    },
  });
};

const addRuleFields = async (template: SeededTemplate) => ({
  agree: await addField(template, {
    type: FieldType.CHECKBOX,
    positionY: 20,
    fieldMeta: { type: 'checkbox', fieldKey: 'agree', values: [{ id: 1, checked: false, value: 'Yes' }] },
  }),
  details: await addField(template, {
    type: FieldType.TEXT,
    positionY: 30,
    fieldMeta: {
      type: 'text',
      label: 'Details',
      required: true,
      condition: { fieldKey: 'agree', operator: 'checked', value: 'Yes' },
    },
  }),
  price: await addField(template, {
    type: FieldType.NUMBER,
    positionY: 40,
    fieldMeta: { type: 'number', fieldKey: 'price' },
  }),
  quantity: await addField(template, {
    type: FieldType.NUMBER,
    positionY: 50,
    fieldMeta: { type: 'number', fieldKey: 'quantity' },
  }),
  total: await addField(template, {
    type: FieldType.NUMBER,
    positionY: 60,
    fieldMeta: { type: 'number', formula: '{{price}} * {{quantity}}' },
  }),
});

const codeFor = async (formId: string, email: string) =>
  await generatePublicFormCode({ key: ENCRYPTION_KEY, formId, email, now: new Date() });

const trpc = async (
  request: APIRequestContext,
  path: string,
  json: Record<string, unknown>,
  { ip, teamId, meta }: { ip?: string; teamId?: number; meta?: Record<string, unknown> } = {},
) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: {
      ...WEBAPP_ORIGIN_HEADERS,
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
      ...(teamId ? { 'x-team-id': String(teamId) } : {}),
    },
    data: JSON.stringify(meta ? { json, meta } : { json }),
  });

const verifyEmail = async (request: APIRequestContext, token: string, formId: string, email: string, ip: string) => {
  const response = await trpc(
    request,
    'publicForm.verifyCode',
    { token, email, code: await codeFor(formId, email) },
    { ip },
  );

  expect(response.ok(), await response.text()).toBe(true);

  const body = (await response.json()) as { result: { data: { json: { proof: string } } } };

  return body.result.data.json.proof;
};

const submit = async (
  request: APIRequestContext,
  template: SeededTemplate,
  options: {
    email: string;
    name?: string;
    ip: string;
    signedFieldValues: { fieldId: number; value: string }[];
    verifiedProof?: string;
    openedToken?: string;
    honeypot?: string;
  },
) => {
  const { updatedAt } = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });

  const form = await prisma.stPublicForm.findUniqueOrThrow({ where: { directLinkId: template.directLink.id } });

  return await trpc(
    request,
    'template.createDocumentFromDirectTemplate',
    {
      directTemplateToken: template.directLink.token,
      directRecipientEmail: options.email,
      directRecipientName: options.name ?? 'Form Visitor',
      templateUpdatedAt: updatedAt.toISOString(),
      signedFieldValues: options.signedFieldValues.map((value) => ({ token: '', isBase64: false, ...value })),
      publicForm: {
        openedToken:
          options.openedToken ??
          createPublicFormOpenedToken({ key: ENCRYPTION_KEY, formId: form.id, now: new Date(Date.now() - 10_000) }),
        verifiedProof: options.verifiedProof,
        honeypot: options.honeypot ?? '',
      },
    },
    { ip: options.ip, meta: { values: { templateUpdatedAt: ['Date'] } } },
  );
};

const countDocumentsFromTemplate = async (template: SeededTemplate) =>
  await prisma.envelope.count({ where: { templateId: mapSecondaryIdToTemplateId(template.secondaryId) } });

const fillRateLimitBucket = async ({
  ip,
  action,
  window,
  count,
}: {
  ip: string;
  action: string;
  window: '1h' | '10m';
  count: number;
}) => {
  const bucket = getBucket(parseWindow(window));

  await prisma.rateLimit.upsert({
    where: { key_action_bucket: { key: `ip:${ip}`, action, bucket } },
    create: { key: `ip:${ip}`, action, bucket, count },
    update: { count },
  });
};

const clickFieldOnCanvas = async (
  page: Page,
  field: { positionX: unknown; positionY: unknown; width: unknown; height: unknown },
) => {
  const canvas = page.locator('.konva-container canvas').first();
  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('Canvas bounding box not found');
  }

  await canvas.click({
    position: {
      x: ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width,
      y: ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height,
    },
  });
};

const fillCanvasField = async (
  page: Page,
  field: { id: number; positionX: unknown; positionY: unknown; width: unknown; height: unknown },
  value: string,
) => {
  const dialog = page.getByRole('dialog');

  await clickFieldOnCanvas(page, field);
  await dialog.getByRole('textbox').fill(value);
  await dialog.getByRole('button', { name: 'Enter' }).click();
  await expect.poll(() => getKonvaFieldTextForPage(page, 1, field.id)).toBe(value);
};

const isFieldOnCanvas = async (page: Page, fieldId: number) =>
  await page.evaluate((fieldId) => {
    const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;
    const stage = konva.stages.find((candidate) => candidate.attrs.id === 'page-1');

    return Boolean(stage?.findOne(`#${fieldId}`));
  }, fieldId);
