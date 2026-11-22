import { z } from 'zod';

/**
 * Solid Ten Sign (S-L5): text that strangers type and other people read (names, reasons,
 * comments) must not carry control characters or bidirectional overrides, which can make
 * "Orig‮LIAM" read as a different name or push "Signed by CEO" onto its own line in an
 * email, the audit log or the certificate.
 */

// Arabic letter mark, LRM, RLM, the embedding / override controls and the isolates.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

// Solid Ten Sign (SEC2-L2): invisible characters that make two names look the same: zero-width
// space, non-joiner and joiner, word joiner and the invisible operators, the byte-order mark,
// the Mongolian vowel separator, the soft hyphen and the Hangul fillers.
const INVISIBLE_CHARACTERS = /[\u00AD\u115F\u1160\u180E\u200B-\u200D\u2060-\u2064\u3164\uFEFF\uFFA0]/g;

// C0 and C1 control characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

// The same, but keeping tab and line feed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const CONTROL_CHARACTERS_EXCEPT_TAB_AND_NEWLINE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** For names and other one-line text: control characters become spaces, runs of spaces one. */
export const sanitizeSingleLineText = (value: string) =>
  value
    .replace(BIDI_CONTROLS, '')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** For free text that may have line breaks: keeps tabs and line breaks, drops the rest. */
export const sanitizeMultiLineText = (value: string) =>
  value.replace(/\r\n?/g, '\n').replace(BIDI_CONTROLS, '').replace(CONTROL_CHARACTERS_EXCEPT_TAB_AND_NEWLINE, '');

/** A zod string that is cleaned with `sanitizeSingleLineText` after its own checks. */
export const zSingleLineText = (max: number) => z.string().max(max).transform(sanitizeSingleLineText);

/** A zod string that is cleaned with `sanitizeMultiLineText` after its own checks. */
export const zMultiLineText = (max: number) => z.string().max(max).transform(sanitizeMultiLineText);
