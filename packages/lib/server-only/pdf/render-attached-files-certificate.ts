// sort-imports-ignore
import '../konva/skia-backend';

import type { Canvas } from '@documenso/skia-canvas';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import Konva from 'konva';
import { DateTime } from 'luxon';

import { formatFileSize } from '../../utils/field-file';
import { ensureFontLibrary } from './helpers';

/**
 * Solid Ten: the "Attached files" pages of the signing certificate. One block per file a
 * signer attached: name, size, SHA-256, who attached it and when.
 */

export type CertificateAttachedFile = {
  fileName: string;
  size: number;
  sha256: string;
  uploaderName: string;
  uploaderEmail: string;
  createdAt: Date;
  fieldLabel: string | null;
  ipAddress: string | null;
};

type RenderAttachedFilesCertificateOptions = {
  files: CertificateAttachedFile[];
  envelopeId: string;
  i18n: I18n;
  pageWidth: number;
  pageHeight: number;
};

const textForeground = '#000';
const textMutedForeground = '#64748B';
const textMutedForegroundLight = '#929DAE';
const textSm = 9;
const textXs = 8;
const fontMedium = '500';
const rowPadding = 12;
const pageTopMargin = 72;
const pageBottomMargin = 24;
const contentMaxWidth = 768;
const titleFontSize = 18;
const lineGap = 4;

const renderLine = ({ label, value, width, y }: { label: string; value: string; width: number; y: number }) => {
  const group = new Konva.Group({ y });

  const labelText = new Konva.Text({
    text: `${label}: `,
    fontFamily: 'Inter',
    fontStyle: fontMedium,
    fontSize: textSm,
    fill: textMutedForeground,
  });

  const valueText = new Konva.Text({
    x: labelText.width(),
    width: width - labelText.width(),
    text: value,
    fontFamily: 'Inter',
    fontSize: textSm,
    fill: textMutedForeground,
    wrap: 'char',
  });

  group.add(labelText);
  group.add(valueText);

  return group;
};

const renderFileBlock = ({ file, width, i18n }: { file: CertificateAttachedFile; width: number; i18n: I18n }) => {
  const block = new Konva.Group();
  const innerWidth = width - rowPadding * 2;

  const name = new Konva.Text({
    x: rowPadding,
    y: rowPadding,
    width: innerWidth,
    text: file.fileName,
    fontFamily: 'Inter',
    fontStyle: '600',
    fontSize: 10,
    fill: textForeground,
    wrap: 'char',
  });

  block.add(name);

  const lines: { label: string; value: string }[] = [
    { label: i18n._(msg`Size`), value: `${formatFileSize(file.size)} (${file.size} bytes)` },
    { label: 'SHA-256', value: file.sha256 },
    { label: i18n._(msg`Attached by`), value: `${file.uploaderName || file.uploaderEmail} (${file.uploaderEmail})` },
    {
      label: i18n._(msg`Attached at`),
      value: DateTime.fromJSDate(file.createdAt).setZone('UTC').toFormat("yyyy-MM-dd HH:mm:ss 'UTC'"),
    },
  ];

  if (file.ipAddress) {
    lines.push({ label: i18n._(msg`IP address`), value: file.ipAddress });
  }

  if (file.fieldLabel) {
    lines.push({ label: i18n._(msg`Field`), value: file.fieldLabel });
  }

  let y = rowPadding + name.height() + lineGap * 2;

  for (const line of lines) {
    const rendered = renderLine({ ...line, width: innerWidth, y });

    rendered.x(rowPadding);
    block.add(rendered);

    y += rendered.getClientRect().height + lineGap;
  }

  const border = new Konva.Rect({
    x: 0,
    y: 0,
    width,
    height: y + rowPadding - lineGap,
    stroke: '#e5e7eb',
    strokeWidth: 1.5,
    cornerRadius: 8,
  });

  block.add(border);

  return { block, height: border.height() };
};

export const renderAttachedFilesCertificate = async ({
  files,
  envelopeId,
  i18n,
  pageWidth,
  pageHeight,
}: RenderAttachedFilesCertificateOptions): Promise<Uint8Array[]> => {
  if (files.length === 0) {
    return [];
  }

  ensureFontLibrary();

  const minimumMargin = 10;
  const width = Math.min(pageWidth - minimumMargin * 2, contentMaxWidth);
  const margin = (pageWidth - width) / 2;
  const blockGap = 12;
  const maxY = pageHeight - pageBottomMargin - textXs - 16;

  const stage = new Konva.Stage({ width: pageWidth, height: pageHeight });
  const pages: Uint8Array[] = [];

  let pageFiles: { block: Konva.Group; height: number }[] = [];
  const pageGroups: { block: Konva.Group; height: number }[][] = [];

  let y = pageTopMargin;

  for (const file of files) {
    const rendered = renderFileBlock({ file, width, i18n });

    if (y + rendered.height > maxY && pageFiles.length > 0) {
      pageGroups.push(pageFiles);
      pageFiles = [];
      y = pageTopMargin;
    }

    pageFiles.push(rendered);
    y += rendered.height + blockGap;
  }

  pageGroups.push(pageFiles);

  for (const group of pageGroups) {
    stage.destroyChildren();

    const page = new Konva.Layer();

    page.add(
      new Konva.Text({
        x: margin,
        y: 0,
        height: pageTopMargin,
        verticalAlign: 'middle',
        text: i18n._(msg`Attached Files`),
        fontFamily: 'Inter',
        fontSize: titleFontSize,
        fontStyle: '700',
      }),
    );

    let blockY = pageTopMargin;

    for (const { block, height } of group) {
      block.setAttrs({ x: margin, y: blockY });
      page.add(block);
      blockY += height + blockGap;
    }

    page.add(
      new Konva.Text({
        x: margin,
        y: pageHeight - textXs - 10,
        text: `${i18n._(msg`Envelope ID`)}: ${envelopeId}`,
        fontFamily: 'Inter',
        fontSize: textXs,
        fill: textMutedForegroundLight,
      }),
    );

    stage.add(page);

    const canvas = page.canvas._canvas as unknown as Canvas; // eslint-disable-line @typescript-eslint/consistent-type-assertions
    const buffer = await canvas.toBuffer('pdf');

    pages.push(new Uint8Array(buffer));
  }

  stage.destroy();

  return pages;
};
