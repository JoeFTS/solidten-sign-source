/**
 * Strip characters that could break the one-line text or be read as control input.
 *
 * Kept apart from message.ts, which uses lingui macros, so settings code can import it safely.
 */
export const sanitizeSmsText = (value: string) =>
  value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
