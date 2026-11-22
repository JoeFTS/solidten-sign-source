import { FieldType } from '@prisma/client';
import Konva from 'konva';

import { DEFAULT_STANDARD_FONT_SIZE } from '../../constants/pdf';
import type { TFileFieldMeta } from '../../types/field-meta';
import {
  createFieldHoverInteraction,
  konvaTextFill,
  konvaTextFontFamily,
  upsertFieldGroup,
  upsertFieldRect,
} from './field-generic-items';
import type { FieldToRender, RenderFieldElementOptions } from './field-renderer';
import { calculateFieldPosition } from './field-renderer';

/**
 * Solid Ten: an "Attach a file" field. The files are stored beside the document, never in
 * it; the box shows their names once attached. Before that it shows the label (or "Attach
 * a file") on screen and nothing in the exported PDF.
 */

const FIELD_PADDING = 6;

const calculateTextBox = (fieldWidth: number, fieldHeight: number) => ({
  x: FIELD_PADDING,
  y: FIELD_PADDING,
  width: Math.max(fieldWidth - FIELD_PADDING * 2, 0),
  height: Math.max(fieldHeight - FIELD_PADDING * 2, 0),
});

export const renderFileFieldElement = (field: FieldToRender, options: RenderFieldElementOptions) => {
  const { pageWidth, pageHeight, pageLayer, mode, translations, color } = options;

  const { fieldWidth, fieldHeight } = calculateFieldPosition(field, pageWidth, pageHeight);

  const fileMeta: TFileFieldMeta | null = field.fieldMeta?.type === 'file' ? field.fieldMeta : null;

  const isFirstRender = !pageLayer.findOne(`#${field.renderId}`);

  const fieldGroup = upsertFieldGroup(field, options);
  fieldGroup.removeChildren();
  fieldGroup.off('transform');

  const fieldRect = upsertFieldRect(field, options);
  fieldGroup.add(fieldRect);

  if (isFirstRender) {
    pageLayer.add(fieldGroup);
  }

  const fontSize = fileMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE;

  let text = fileMeta?.label?.trim() || translations?.[FieldType.FILE] || 'Attach a file';

  if (field.inserted) {
    text = field.customText;
  } else if (mode === 'export') {
    text = '';
  }

  const box = calculateTextBox(fieldWidth, fieldHeight);

  const fileText = new Konva.Text({
    id: `${field.renderId}-text`,
    name: 'file-field-text',
    ...box,
    text,
    fontSize,
    fontFamily: konvaTextFontFamily,
    fill: konvaTextFill,
    verticalAlign: 'middle',
    wrap: 'char',
    ellipsis: true,
    listening: false,
  });

  fieldGroup.add(fileText);

  fieldGroup.on('transform', () => {
    const groupScaleX = fieldGroup.scaleX();
    const groupScaleY = fieldGroup.scaleY();

    const rect = fieldGroup.findOne('.field-rect');
    const label = fieldGroup.findOne('.file-field-text');

    if (!rect || !label) {
      return;
    }

    const rectWidth = rect.width() * groupScaleX;
    const rectHeight = rect.height() * groupScaleY;

    label.setAttrs({ scaleX: 1, scaleY: 1, ...calculateTextBox(rectWidth, rectHeight) });
    rect.setAttrs({ width: rectWidth, height: rectHeight });
    fieldGroup.scale({ x: 1, y: 1 });

    pageLayer.batchDraw();
  });

  if (color !== 'readOnly' && mode !== 'export') {
    createFieldHoverInteraction({ fieldGroup, fieldRect, options });
  }

  return {
    fieldGroup,
    isFirstRender,
  };
};
