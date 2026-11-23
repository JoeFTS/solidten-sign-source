import {
  FIELD_VALUE_MATRIX,
  type TMatrixRow,
} from '@documenso/lib/advanced-fields-validation/__fixtures__/field-value-matrix';
import type { TValueRepresentation } from '@documenso/lib/advanced-fields-validation/field-value-rules';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { createPublicFormOpenedToken } from '@documenso/lib/utils/public-form';
import { prisma } from '@documenso/prisma';
import { FieldType, Prisma } from '@documenso/prisma/client';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign (L round 2): the same value matrix (lib/advanced-fields-validation/__fixtures__/
 * field-value-matrix.ts) against every route that takes a signer's value:
 *
 * - version-1 signing route (field.signFieldWithToken) on a version-1 and on a version-2 document;
 * - version-2 signing route (envelope.field.sign), with the values it can express;
 * - direct link (version-1 and version-2 template) and public form (version 2).
 *
 * Expected: ok and empty → accepted (direct routes: a document is created); refused → 400 and
 * nothing stored. `''` is what the version-2 pages send for a field the visitor did not touch.
 */

test.describe.configure({ mode: 'parallel', timeout: 600_000 });

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const ENCRYPTION_KEY = process.env.NEXT_PRIVATE_ENCRYPTION_KEY ?? '';

const post = async (request: APIRequestContext, path: string, body: unknown, ip?: string) =>
  await request.post(`${BASE}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    data: JSON.stringify(body),
    timeout: 60_000,
  });

const nextIp = (() => {
  let counter = 0;

  return () => {
    counter++;

    return `198.18.${Math.floor(counter / 250) % 250}.${(counter % 250) + 1}`;
  };
})();

const failures: string[] = [];

const verdict = (row: TMatrixRow, route: string, accepted: boolean, detail: string) => {
  const expectedAccepted = row.expect !== 'refused';

  if (accepted !== expectedAccepted) {
    failures.push(
      `${route} | ${row.name}: expected ${row.expect}, got ${accepted ? 'accepted' : 'refused'} (${detail})`,
    );
  }
};

/** A field for a recipient of a document or template. */
const addField = async (envelopeId: string, recipientId: number, row: TMatrixRow, positionY: number) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  return await prisma.field.create({
    data: {
      envelopeId,
      envelopeItemId: item.id,
      recipientId,
      type: row.type,
      page: 1,
      positionX: new Prisma.Decimal(40),
      positionY: new Prisma.Decimal(positionY),
      width: new Prisma.Decimal(20),
      height: new Prisma.Decimal(3),
      customText: '',
      inserted: false,
      // biome-ignore lint/suspicious/noExplicitAny: raw meta, as stored.
      fieldMeta: (row.meta ?? Prisma.JsonNull) as any,
    },
  });
};

const rowsFor = (representation: TValueRepresentation) =>
  FIELD_VALUE_MATRIX.filter((row) => row.values[representation] !== undefined);

/* -------------------------------------------------------------------------- */
/*   Signing routes                                                           */
/* -------------------------------------------------------------------------- */

const seedDocument = async (internalVersion: 1 | 2, typedSignatureEnabled: boolean) => {
  const { user, team } = await seedUser();
  const document = await seedPendingDocument(
    user,
    team.id,
    [`routes-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`],
    { internalVersion },
  );

  await prisma.documentMeta.update({ where: { id: document.documentMetaId }, data: { typedSignatureEnabled } });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  return { document, recipient };
};

for (const internalVersion of [1, 2] as const) {
  test(`version-1 signing route on a version-${internalVersion} document`, async ({ request }) => {
    const representation: TValueRepresentation = internalVersion === 2 ? 'option-index' : 'option-value';
    const route = `field.signFieldWithToken (V${internalVersion} document)`;
    const docs = { on: await seedDocument(internalVersion, true), off: await seedDocument(internalVersion, false) };
    let positionY = 1;

    for (const row of rowsFor(representation)) {
      const { document, recipient } = row.typedSignatureEnabled === false ? docs.off : docs.on;
      positionY = (positionY % 90) + 2;
      const field = await addField(document.id, recipient.id, row, positionY);

      const response = await post(request, 'field.signFieldWithToken', {
        json: { token: recipient.token, fieldId: field.id, value: row.values[representation], isBase64: false },
      });

      const stored = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

      if (!response.ok()) {
        expect(response.status(), `${route} | ${row.name}`).toBe(400);
        expect(stored.inserted, `${route} | ${row.name}: nothing stored`).toBe(false);
      }

      verdict(row, route, response.ok(), String(response.status()));
    }

    expect(failures.filter((line) => line.startsWith(route))).toEqual([]);
  });
}

/** A version-2 route value for a matrix value, or undefined when the route cannot express it. */
const toV2FieldValue = (type: FieldType, value: string) => {
  if (type === FieldType.RADIO) {
    return /^\d+$/.test(value) && String(Number(value)) === value ? Number(value) : undefined;
  }

  if (type === FieldType.CHECKBOX) {
    try {
      const parsed: unknown = JSON.parse(value);

      return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'number')
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  if (type === FieldType.DATE) {
    return value ? true : undefined;
  }

  return value;
};

test('version-2 signing route (envelope.field.sign)', async ({ request }) => {
  const route = 'envelope.field.sign';
  const docs = { on: await seedDocument(2, true), off: await seedDocument(2, false) };
  let positionY = 1;
  let ran = 0;

  for (const row of rowsFor('option-index')) {
    const value = toV2FieldValue(row.type, row.values['option-index'] ?? '');

    // An untouched field is never sent on this route (null means "clear it"); values it cannot
    // express (strings for indexes, "01") are refused by its input schema already.
    if (value === undefined || row.values['option-index'] === '') {
      continue;
    }

    ran++;
    const { document, recipient } = row.typedSignatureEnabled === false ? docs.off : docs.on;
    positionY = (positionY % 90) + 2;
    const field = await addField(document.id, recipient.id, row, positionY);

    const response = await post(request, 'envelope.field.sign', {
      json: { token: recipient.token, fieldId: field.id, fieldValue: { type: row.type, value } },
    });

    const stored = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    if (!response.ok()) {
      expect(response.status(), `${route} | ${row.name}`).toBe(400);
      expect(stored.inserted, `${route} | ${row.name}: nothing stored`).toBe(false);
    }

    // This route never takes a value for a read-only field (it is filled when the document is
    // sent): refused whatever the value.
    const isReadOnly = Boolean((row.meta as { readOnly?: boolean } | null)?.readOnly);

    if (isReadOnly) {
      expect(response.status(), `${route} | ${row.name}: read-only`).toBe(400);
      continue;
    }

    verdict(row, route, response.ok(), `${response.status()} ${(await response.text()).slice(0, 120)}`);
  }

  expect(ran).toBeGreaterThan(20);
  expect(failures.filter((line) => line.startsWith(route))).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/*   Direct links and public forms                                            */
/* -------------------------------------------------------------------------- */

const submitDirect = async (
  request: APIRequestContext,
  row: TMatrixRow,
  { internalVersion, publicForm }: { internalVersion: 1 | 2; publicForm: boolean },
) => {
  const representation: TValueRepresentation = internalVersion === 2 ? 'option-index' : 'option-value';
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: `Routes ${row.name} ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion,
  });
  const directLink = template.directLink;

  if (!directLink) {
    throw new Error('no direct link');
  }

  if (row.typedSignatureEnabled === false) {
    await prisma.documentMeta.update({
      where: { id: template.documentMetaId },
      data: { typedSignatureEnabled: false },
    });
  }

  const signatureField = template.fields[0];
  const value = row.values[representation] ?? '';

  // A signature row uses the template's own signature field.
  const signedFieldValues =
    row.type === FieldType.SIGNATURE
      ? [{ token: '', fieldId: signatureField.id, value, isBase64: false }]
      : [
          { token: '', fieldId: signatureField.id, value: 'Sam Rivera', isBase64: false },
          {
            token: '',
            fieldId: (await addField(template.id, directLink.directTemplateRecipientId, row, 40)).id,
            value,
            isBase64: false,
          },
        ];

  let publicFormPayload: Record<string, unknown> | undefined;

  if (publicForm) {
    const form = await prisma.stPublicForm.create({
      data: { directLinkId: directLink.id, requireVerifiedEmail: false },
    });

    publicFormPayload = {
      openedToken: createPublicFormOpenedToken({
        key: ENCRYPTION_KEY,
        formId: form.id,
        now: new Date(Date.now() - 10_000),
      }),
      honeypot: '',
    };
  }

  const { updatedAt } = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });

  const response = await post(
    request,
    'template.createDocumentFromDirectTemplate',
    {
      json: {
        directTemplateToken: directLink.token,
        directRecipientName: 'Sam Rivera',
        directRecipientEmail: `routes-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`,
        templateUpdatedAt: updatedAt.toISOString(),
        signedFieldValues,
        ...(publicFormPayload ? { publicForm: publicFormPayload } : {}),
      },
      meta: { values: { templateUpdatedAt: ['Date'] } },
    },
    nextIp(),
  );

  const documents = await prisma.envelope.count({
    where: { templateId: mapSecondaryIdToTemplateId(template.secondaryId) },
  });

  return { response, documents };
};

for (const [label, internalVersion, publicForm] of [
  ['direct link (version-1 template)', 1, false],
  ['direct link (version-2 template)', 2, false],
  ['public form (version 2)', 2, true],
] as const) {
  test(label, async ({ request }) => {
    const representation: TValueRepresentation = internalVersion === 2 ? 'option-index' : 'option-value';

    for (const row of rowsFor(representation)) {
      const { response, documents } = await submitDirect(request, row, { internalVersion, publicForm });

      if (response.ok()) {
        expect(documents, `${label} | ${row.name}: a document`).toBe(1);
      } else {
        expect(response.status(), `${label} | ${row.name}: ${(await response.text()).slice(0, 200)}`).toBe(400);
        expect(documents, `${label} | ${row.name}: no document`).toBe(0);
      }

      verdict(
        row,
        label,
        response.ok(),
        `${response.status()} ${response.ok() ? '' : (await response.text()).slice(0, 160)}`,
      );
    }

    expect(failures.filter((line) => line.startsWith(label))).toEqual([]);
  });
}

test('direct link: a field of another template, or one that does not exist, refuses the submission', async ({
  request,
}) => {
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: `Foreign ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });
  const other = await seedDirectTemplate({
    title: `Other ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });
  const { updatedAt } = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });

  for (const foreignId of [other.fields[0].id, 999_999_999]) {
    const response = await post(
      request,
      'template.createDocumentFromDirectTemplate',
      {
        json: {
          directTemplateToken: template.directLink?.token,
          directRecipientName: 'Sam Rivera',
          directRecipientEmail: `foreign-${Date.now()}@test.documenso.com`,
          templateUpdatedAt: updatedAt.toISOString(),
          signedFieldValues: [
            { token: '', fieldId: template.fields[0].id, value: 'Sam Rivera', isBase64: false },
            { token: '', fieldId: foreignId, value: 'x', isBase64: false },
          ],
        },
        meta: { values: { templateUpdatedAt: ['Date'] } },
      },
      nextIp(),
    );

    expect(response.status()).toBe(400);
    expect(await response.text()).toContain('A submitted field is not part of this form.');
  }

  expect(await prisma.envelope.count({ where: { templateId: mapSecondaryIdToTemplateId(template.secondaryId) } })).toBe(
    0,
  );
});
