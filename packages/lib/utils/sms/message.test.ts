import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { buildSmsBody, createSigningSmsRenderer, getSmsSegmentInfo, sanitizeSmsText } from './message';

const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

const LINK = 'https://sign.example.com/sign/abcdefghijklmnopqrstu';

describe('getSmsSegmentInfo', () => {
  it('fits 160 GSM-7 characters in one segment and 161 in two', () => {
    expect(getSmsSegmentInfo('a'.repeat(160))).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
    expect(getSmsSegmentInfo('a'.repeat(161))).toEqual({ encoding: 'GSM-7', units: 161, segments: 2 });
    expect(getSmsSegmentInfo('a'.repeat(307)).segments).toBe(3);
  });

  it('counts extension characters as two septets', () => {
    expect(getSmsSegmentInfo('€'.repeat(80))).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
    expect(getSmsSegmentInfo('€'.repeat(81)).segments).toBe(2);
  });

  it('switches to UCS-2 for characters outside GSM-7', () => {
    expect(getSmsSegmentInfo('ł'.repeat(70))).toEqual({ encoding: 'UCS-2', units: 70, segments: 1 });
    expect(getSmsSegmentInfo('ł'.repeat(71))).toEqual({ encoding: 'UCS-2', units: 71, segments: 2 });
  });

  it('counts an emoji as two UTF-16 units', () => {
    expect(getSmsSegmentInfo('😀'.repeat(35))).toEqual({ encoding: 'UCS-2', units: 70, segments: 1 });
  });
});

describe('createSigningSmsRenderer', () => {
  it('renders the first request with the opt-out line', () => {
    const render = createSigningSmsRenderer({
      i18n,
      purpose: 'SIGNING_REQUEST',
      senderLabel: 'Acme Ltd',
      actionVerb: 'sign',
      link: LINK,
    });

    expect(render('Lease')).toBe(`Acme Ltd: please sign "Lease" ${LINK} Reply STOP to opt out.`);
  });

  it('renders reminders without the opt-out line', () => {
    const render = createSigningSmsRenderer({
      i18n,
      purpose: 'REMINDER',
      senderLabel: 'Acme',
      actionVerb: 'approve',
      link: LINK,
    });

    expect(render('Lease')).toBe(`Acme: reminder, please approve "Lease" ${LINK}`);
  });

  it('flattens newlines and control characters in user text', () => {
    const render = createSigningSmsRenderer({
      i18n,
      purpose: 'REMINDER',
      senderLabel: 'Acme\r\nInc',
      actionVerb: 'sign',
      link: LINK,
    });

    expect(render('Line one\nline\u0007two')).toBe(`Acme Inc: reminder, please sign "Line one line two" ${LINK}`);
  });
});

describe('buildSmsBody', () => {
  const render = createSigningSmsRenderer({
    i18n,
    purpose: 'SIGNING_REQUEST',
    senderLabel: 'Acme',
    actionVerb: 'sign',
    link: LINK,
  });

  it('keeps a short title unchanged in one segment', () => {
    const result = buildSmsBody({ render, title: 'NDA' });

    expect(result).toEqual({ success: true, body: render('NDA'), segments: 1, isTitleShortened: false });
  });

  it('shortens a long title to stay in one segment and never cuts the link', () => {
    const title = 'Master services agreement between Acme Incorporated and Example Holdings for 2027';
    const result = buildSmsBody({ render, title });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.segments).toBe(1);
    expect(result.isTitleShortened).toBe(true);
    expect(result.body).toContain(LINK);
    expect(result.body).toContain('Master services');
    expect(result.body).toContain('..."');
    expect(getSmsSegmentInfo(result.body).units).toBeLessThanOrEqual(160);
  });

  it('allows two segments when one is impossible even with a short title', () => {
    const longRender = createSigningSmsRenderer({
      i18n,
      purpose: 'SIGNING_REQUEST',
      senderLabel: 'A'.repeat(40),
      actionVerb: 'sign',
      link: `${LINK}${'x'.repeat(60)}`,
    });

    const result = buildSmsBody({ render: longRender, title: 'Lease agreement for unit 4' });

    expect(result).toMatchObject({ success: true, segments: 2 });
  });

  it('fails when even the shortest title cannot fit in two segments', () => {
    const result = buildSmsBody({ render: (title) => `${'x'.repeat(400)} ${title}`, title: 'Anything at all' });

    expect(result).toEqual({ success: false, error: 'MESSAGE_TOO_LONG' });
  });

  it('measures unicode titles in UCS-2 units', () => {
    const result = buildSmsBody({ render, title: 'Umowa najmu – Łódź, ulica Piotrkowska 12' });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(getSmsSegmentInfo(result.body).segments).toBe(result.segments);
      expect(result.segments).toBeLessThanOrEqual(2);
    }
  });
});

describe('sanitizeSmsText', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(sanitizeSmsText('  a\t\tb\u0000c  ')).toBe('a b c');
  });
});
