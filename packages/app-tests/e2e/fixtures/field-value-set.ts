import { prisma } from '@documenso/prisma';
import { FieldType } from '@documenso/prisma/client';
import type { Page } from '@playwright/test';

/**
 * Solid Ten Sign (L round 2): one field of every type, for the field-value tests. Optional
 * versions only where the app has an optional setting (text, number, dropdown, radio, checkbox);
 * email, name, initials, date and signature are always required (isRequiredField).
 * Based on the tester's probe set (tw-final23/probe/fields.ts and tap.spec.ts).
 */
export type TFieldKey =
  | 'radioReq'
  | 'radioOpt'
  | 'cbReq'
  | 'cbOpt'
  | 'dropdownReq'
  | 'dropdownOpt'
  | 'numberReq'
  | 'numberOpt'
  | 'textReq'
  | 'textOpt'
  | 'email'
  | 'name'
  | 'initials'
  | 'date'
  | 'signature';

const radioValues = [
  { id: 1, checked: false, value: 'Yes' },
  { id: 2, checked: false, value: 'No' },
];

const checkboxValues = [
  { id: 1, checked: false, value: 'A' },
  { id: 2, checked: false, value: 'B' },
  { id: 3, checked: false, value: 'C' },
];

export const FIELD_SET: { key: TFieldKey; type: FieldType; meta: Record<string, unknown> | null }[] = [
  { key: 'radioReq', type: FieldType.RADIO, meta: { type: 'radio', required: true, values: radioValues } },
  { key: 'radioOpt', type: FieldType.RADIO, meta: { type: 'radio', required: false, values: radioValues } },
  {
    key: 'cbReq',
    type: FieldType.CHECKBOX,
    meta: {
      type: 'checkbox',
      required: true,
      values: checkboxValues,
      validationRule: 'Select at least',
      validationLength: 2,
    },
  },
  {
    key: 'cbOpt',
    type: FieldType.CHECKBOX,
    meta: {
      type: 'checkbox',
      required: false,
      values: checkboxValues,
      validationRule: 'Select at least',
      validationLength: 2,
    },
  },
  {
    key: 'dropdownReq',
    type: FieldType.DROPDOWN,
    meta: { type: 'dropdown', required: true, values: [{ value: 'Lunch' }, { value: 'Dinner' }] },
  },
  {
    key: 'dropdownOpt',
    type: FieldType.DROPDOWN,
    meta: { type: 'dropdown', required: false, values: [{ value: 'Lunch' }, { value: 'Dinner' }] },
  },
  {
    key: 'numberReq',
    type: FieldType.NUMBER,
    meta: { type: 'number', label: 'Guests', required: true, minValue: 1, maxValue: 10 },
  },
  {
    key: 'numberOpt',
    type: FieldType.NUMBER,
    meta: { type: 'number', label: 'Extra', required: false, minValue: 1, maxValue: 10 },
  },
  { key: 'textReq', type: FieldType.TEXT, meta: { type: 'text', label: 'Note', required: true, characterLimit: 10 } },
  { key: 'textOpt', type: FieldType.TEXT, meta: { type: 'text', label: 'Remarks', required: false } },
  { key: 'email', type: FieldType.EMAIL, meta: { type: 'email' } },
  { key: 'name', type: FieldType.NAME, meta: { type: 'name' } },
  { key: 'initials', type: FieldType.INITIALS, meta: { type: 'initials' } },
  { key: 'date', type: FieldType.DATE, meta: { type: 'date' } },
  { key: 'signature', type: FieldType.SIGNATURE, meta: { type: 'signature', fontSize: 18 } },
];

/** Put the set on a recipient (replacing its fields). Returns key -> field id. */
export const addFieldValueSet = async (envelopeId: string, recipientId: number, only?: TFieldKey[]) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  await prisma.field.deleteMany({ where: { envelopeId, recipientId } });

  const ids = {} as Record<TFieldKey, number>;
  let index = 0;

  for (const definition of FIELD_SET) {
    if (only && !only.includes(definition.key)) {
      continue;
    }

    const column = index % 3;
    const row = Math.floor(index / 3);
    index++;

    const field = await prisma.field.create({
      data: {
        envelopeId,
        envelopeItemId: item.id,
        recipientId,
        type: definition.type,
        page: 1,
        positionX: 3 + column * 33,
        positionY: 4 + row * 12,
        width: 28,
        height: 5,
        customText: '',
        inserted: false,
        // biome-ignore lint/suspicious/noExplicitAny: raw meta, as stored.
        ...(definition.meta ? { fieldMeta: definition.meta as any } : {}),
      },
    });

    ids[definition.key] = field.id;
  }

  return ids;
};

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fill the fields by real taps on a version-2 page (canvas), leaving the keys in `skip` untouched.
 * Adopts a typed signature in the side panel first when the page offers one.
 */
export const tapFieldValueSetV2 = async (page: Page, ids: Partial<Record<TFieldKey, number>>, skip: TFieldKey[]) => {
  const pad = page.getByTestId('signature-pad-dialog-button');

  if (await pad.isVisible().catch(() => false)) {
    await pad.click();
    await page.getByRole('tab', { name: 'Type' }).click();
    await page.getByTestId('signature-pad-type-input').fill('Sam Rivera');
    await page.getByRole('button', { name: 'Next' }).click();
    await sleep(600);
  }

  const canvas = page.locator('.konva-container canvas').first();
  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('No canvas');
  }

  const rects = (await page.evaluate((fieldIds) => {
    // biome-ignore lint/suspicious/noExplicitAny: Konva on the page.
    const konva = (window as any).Konva;
    // biome-ignore lint/suspicious/noExplicitAny: Konva on the page.
    const stage = konva.stages.find((candidate: any) => candidate.attrs.id === 'page-1');
    const result: Record<string, unknown> = {};

    for (const [key, id] of Object.entries(fieldIds)) {
      const group = stage?.findOne(`#${id}`);

      if (!group) {
        continue;
      }

      const options: unknown[] = [];
      type TKonvaNode = { name: () => string; getClientRect: () => unknown };
      const nodes: TKonvaNode[] = group.find(
        (node: TKonvaNode) => node.name() === 'radio-circle' || node.name() === 'checkbox-square',
      );

      for (const node of nodes) {
        options.push(node.getClientRect());
      }
      result[key] = { rect: group.getClientRect(), options };
    }

    return result;
  }, ids)) as Record<string, { rect: TRect; options: TRect[] }>;

  const tap = async (rect: TRect) => {
    await page.mouse.click(box.x + rect.x + rect.width / 2, box.y + rect.y + rect.height / 2);
    await sleep(700);
  };

  const fillDialog = async (value: string) => {
    const dialog = page.getByRole('dialog').first();

    if (!(await dialog.isVisible().catch(() => false))) {
      return;
    }

    const textbox = dialog.getByRole('textbox').first();

    if (value && (await textbox.isVisible().catch(() => false))) {
      await textbox.fill(value);
    }

    await dialog
      .getByRole('button', { name: /^(Enter|Save|Sign)$/ })
      .first()
      .click({ timeout: 5_000 });
    await sleep(700);
  };

  const wants = (key: TFieldKey) => ids[key] !== undefined && !skip.includes(key);

  for (const key of ['radioReq', 'radioOpt'] as const) {
    if (wants(key)) {
      await tap(rects[key].options[0]);
    }
  }

  for (const key of ['cbReq', 'cbOpt'] as const) {
    if (wants(key)) {
      await tap(rects[key].options[0]);
      const dialog = page.getByRole('dialog').first();

      if (await dialog.isVisible().catch(() => false)) {
        await dialog.locator('#checkbox-value-1').click();
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await sleep(700);
      } else {
        await tap(rects[key].options[1]);
      }
    }
  }

  for (const key of ['dropdownReq', 'dropdownOpt'] as const) {
    if (wants(key)) {
      await tap(rects[key].rect);
      const dialog = page.getByRole('dialog').first();
      await dialog.getByRole('combobox').click();
      await page.getByRole('option', { name: 'Dinner' }).click();
      await sleep(700);

      if (await dialog.isVisible().catch(() => false)) {
        const button = dialog.getByRole('button', { name: /Enter|Save|Select/ }).first();

        if (await button.isVisible().catch(() => false)) {
          await button.click();
        } else {
          await page.keyboard.press('Escape');
        }
      }
    }
  }

  const typed: [TFieldKey, string][] = [
    ['numberReq', '7'],
    ['numberOpt', '3'],
    ['textReq', 'Thanks'],
    ['textOpt', 'Fine'],
    ['email', 'sam@example.com'],
    ['name', 'Sam Rivera'],
    ['initials', 'SR'],
    ['date', ''],
    ['signature', ''],
  ];

  for (const [key, value] of typed) {
    if (wants(key)) {
      await tap(rects[key].rect);
      await fillDialog(value);
    }
  }
};

type TRect = { x: number; y: number; width: number; height: number };
