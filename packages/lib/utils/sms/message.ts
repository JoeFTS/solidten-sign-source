import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

import { sanitizeSmsText } from './text';

// GSM 03.38 basic character set. Any other character forces UCS-2 encoding, which shrinks a
// segment from 160 to 70 characters.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

// Extension table characters cost two septets each (escape + char).
const GSM_EXTENDED = '^{}\\[~]|€\f';

export type TSmsEncoding = 'GSM-7' | 'UCS-2';

export type TSmsSegmentInfo = {
  encoding: TSmsEncoding;
  /** Length in encoding units: septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
};

export const getSmsSegmentInfo = (body: string): TSmsSegmentInfo => {
  let septets = 0;
  let isGsm = true;

  for (const char of body) {
    if (GSM_BASIC.includes(char)) {
      septets += 1;
    } else if (GSM_EXTENDED.includes(char)) {
      septets += 2;
    } else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    return {
      encoding: 'GSM-7',
      units: septets,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }

  // UCS-2 counts UTF-16 code units; an emoji takes two.
  const units = body.length;

  return {
    encoding: 'UCS-2',
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
  };
};

/**
 * Texts are capped at two segments. Carriers bill per segment and long texts read as spam.
 */
export const SMS_MAX_SEGMENTS = 2;

export type TBuildSmsBodyOptions = {
  /** Builds the full text for a given (possibly shortened) document title. */
  render: (title: string) => string;
  title: string;
  /** Aim for one segment by shortening the title; the hard cap is SMS_MAX_SEGMENTS. */
  targetSegments?: number;
  maxSegments?: number;
};

export type TBuildSmsBodyResult =
  | { success: true; body: string; segments: number; isTitleShortened: boolean }
  | { success: false; error: 'MESSAGE_TOO_LONG' };

/**
 * Render the text and shorten the document title until it fits. The link and sender label are
 * never shortened, because a cut link is useless.
 */
export const buildSmsBody = ({
  render,
  title,
  targetSegments = 1,
  maxSegments = SMS_MAX_SEGMENTS,
}: TBuildSmsBodyOptions): TBuildSmsBodyResult => {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleanTitle);

  const tryLength = (length: number) => {
    const shortTitle = length >= chars.length ? cleanTitle : `${chars.slice(0, length).join('').trimEnd()}...`;
    const body = render(shortTitle);

    return { body, info: getSmsSegmentInfo(body), isTitleShortened: length < chars.length };
  };

  for (const limit of [targetSegments, maxSegments]) {
    const full = tryLength(chars.length);

    if (full.info.segments <= limit) {
      return { success: true, body: full.body, segments: full.info.segments, isTitleShortened: false };
    }

    // A title shorter than this says nothing useful; fall through to the next limit.
    const MIN_TITLE_LENGTH = 8;

    let low = Math.min(MIN_TITLE_LENGTH, chars.length);
    let high = chars.length - 1;
    let best: ReturnType<typeof tryLength> | null = null;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const attempt = tryLength(mid);

      if (attempt.info.segments <= limit) {
        best = attempt;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (best) {
      return { success: true, body: best.body, segments: best.info.segments, isTitleShortened: best.isTitleShortened };
    }
  }

  return { success: false, error: 'MESSAGE_TOO_LONG' };
};

export { sanitizeSmsText } from './text';

export type TRenderSigningSmsOptions = {
  i18n: I18n;
  purpose: 'SIGNING_REQUEST' | 'REMINDER' | 'RESEND';
  senderLabel: string;
  /** Already translated and lower case, e.g. "sign" or "approve". */
  actionVerb: string;
  link: string;
};

/**
 * Returns a render function for buildSmsBody: the title is the only part it may shorten.
 */
export const createSigningSmsRenderer = ({
  i18n,
  purpose,
  senderLabel,
  actionVerb,
  link,
}: TRenderSigningSmsOptions) => {
  const label = sanitizeSmsText(senderLabel).slice(0, 40);

  return (rawTitle: string) => {
    const title = sanitizeSmsText(rawTitle);

    if (purpose === 'SIGNING_REQUEST') {
      return i18n._(msg`${label}: please ${actionVerb} "${title}" ${link} Reply STOP to opt out.`);
    }

    return i18n._(msg`${label}: reminder, please ${actionVerb} "${title}" ${link}`);
  };
};
