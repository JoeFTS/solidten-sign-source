/**
 * Solid Ten Sign: the code input (input-otp 1.4.2) appends `<style id="input-otp-style">` to the
 * head the first time it mounts. That element has no CSP nonce, so `style-src-elem` refuses it and
 * the console logs an error (seen on the emailed-code box). The library skips the injection when an
 * element with that id already exists, so we render it on the server with the nonce and the same
 * rules. Re-check these rules when input-otp is upgraded.
 */
const HIDDEN = [
  'background: transparent !important',
  'color: transparent !important',
  'border-color: transparent !important',
  'opacity: 0 !important',
  'box-shadow: none !important',
  '-webkit-box-shadow: none !important',
  '-webkit-text-fill-color: transparent !important',
].join('; ');

export const INPUT_OTP_STYLE_CSS = [
  '[data-input-otp]::selection { background: transparent !important; color: transparent !important; }',
  `[data-input-otp]:autofill { ${HIDDEN}; }`,
  `[data-input-otp]:-webkit-autofill { ${HIDDEN}; }`,
  '@supports (-webkit-touch-callout: none) { [data-input-otp] { letter-spacing: -.6em !important; font-weight: 100 !important; font-stretch: ultra-condensed; font-optical-sizing: none !important; left: -1px !important; right: 1px !important; } }',
  '[data-input-otp] + * { pointer-events: all !important; }',
].join('\n');

export const InputOtpStyle = ({ nonce }: { nonce: string | undefined }) => (
  // biome-ignore lint/security/noDangerouslySetInnerHtml: static CSS, no user data.
  <style id="input-otp-style" nonce={nonce} dangerouslySetInnerHTML={{ __html: INPUT_OTP_STYLE_CSS }} />
);
