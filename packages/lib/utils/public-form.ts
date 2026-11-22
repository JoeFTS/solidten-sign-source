import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { generateHOTP } from 'oslo/otp';

/**
 * A person needs at least this long to read a form and sign it. A faster submission is a script.
 */
export const PUBLIC_FORM_MIN_SUBMIT_SECONDS = 5;

/**
 * After this the page must be reloaded, so an opened token cannot be farmed and reused for days.
 */
export const PUBLIC_FORM_OPENED_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const PUBLIC_FORM_VERIFIED_PROOF_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * A code is valid for the 10 minute period it was made in and the one after it, so it lasts
 * between 10 and 20 minutes. The email says 10.
 */
export const PUBLIC_FORM_CODE_PERIOD_MS = 10 * 60 * 1000;
export const PUBLIC_FORM_CODE_EXPIRATION_MINUTES = 10;
const PUBLIC_FORM_CODE_WINDOW = 2;

export const PUBLIC_FORM_MAX_WRONG_CODES = 5;

export const PUBLIC_FORM_INTRO_TEXT_MAX_LENGTH = 2000;
export const PUBLIC_FORM_THANK_YOU_MAX_LENGTH = 2000;
export const PUBLIC_FORM_MAX_SUBMISSIONS_LIMIT = 1_000_000;

export type PublicFormWindow = {
  opensAt: Date | null;
  closesAt: Date | null;
  closedAt: Date | null;
  maxSubmissions: number | null;
  submissionCount: number;
};

export type PublicFormAvailability = 'OPEN' | 'NOT_OPEN_YET' | 'CLOSED' | 'FULL';

/**
 * Whether a form takes submissions at `now`. The close date is exclusive: a form that closes
 * at 17:00 refuses a submission at 17:00.
 */
export const getPublicFormAvailability = (form: PublicFormWindow, now: Date): PublicFormAvailability => {
  if (form.closedAt && form.closedAt.getTime() <= now.getTime()) {
    return 'CLOSED';
  }

  if (form.closesAt && form.closesAt.getTime() <= now.getTime()) {
    return 'CLOSED';
  }

  if (form.opensAt && form.opensAt.getTime() > now.getTime()) {
    return 'NOT_OPEN_YET';
  }

  if (form.maxSubmissions !== null && form.submissionCount >= form.maxSubmissions) {
    return 'FULL';
  }

  return 'OPEN';
};

/**
 * The honeypot is an input people never see. Any value in it came from a bot that fills
 * every field it finds.
 */
export const isHoneypotFilled = (value: string | null | undefined) => typeof value === 'string' && value.length > 0;

const sign = (key: string, purpose: string, parts: (string | number)[]) =>
  bytesToHex(hmac(sha256, key, `st-public-form|v1|${purpose}|${parts.join('|')}`));

const isSameHex = (a: string, b: string) => {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return difference === 0;
};

const parseSignedToken = (token: string) => {
  const [issuedAtText, signature, extra] = token.split('.');

  // Solid Ten Sign (AUD-C6): only the canonical number (no leading zero). The one-use check
  // hashes the proof text, so every valid proof must have exactly one spelling.
  if (extra !== undefined || !issuedAtText || !signature || !/^[1-9]\d{0,14}$/.test(issuedAtText)) {
    return null;
  }

  return { issuedAt: Number(issuedAtText), signature };
};

/**
 * Issued by the server when the form page loads. The submit route uses it to measure how long
 * the visitor took, so the browser cannot claim an earlier start time.
 */
export const createPublicFormOpenedToken = ({ key, formId, now }: { key: string; formId: string; now: Date }) => {
  const issuedAt = now.getTime();

  return `${issuedAt}.${sign(key, 'opened', [formId, issuedAt])}`;
};

export type PublicFormOpenedTokenCheck = 'OK' | 'INVALID' | 'TOO_FAST' | 'EXPIRED';

export const checkPublicFormOpenedToken = ({
  key,
  formId,
  token,
  now,
}: {
  key: string;
  formId: string;
  token: string | null | undefined;
  now: Date;
}): PublicFormOpenedTokenCheck => {
  const parsed = token ? parseSignedToken(token) : null;

  if (!parsed || !isSameHex(parsed.signature, sign(key, 'opened', [formId, parsed.issuedAt]))) {
    return 'INVALID';
  }

  const elapsed = now.getTime() - parsed.issuedAt;

  if (elapsed < PUBLIC_FORM_MIN_SUBMIT_SECONDS * 1000) {
    return 'TOO_FAST';
  }

  if (elapsed > PUBLIC_FORM_OPENED_TOKEN_MAX_AGE_MS) {
    return 'EXPIRED';
  }

  return 'OK';
};

/**
 * Handed to the browser after a correct code. Submitting with it proves the email address was
 * verified for this form, without keeping any state on the server.
 */
export const createPublicFormVerifiedProof = ({
  key,
  formId,
  email,
  now,
}: {
  key: string;
  formId: string;
  email: string;
  now: Date;
}) => {
  const issuedAt = now.getTime();

  return `${issuedAt}.${sign(key, 'verified', [formId, email.toLowerCase(), issuedAt])}`;
};

export const isPublicFormVerifiedProofValid = ({
  key,
  formId,
  email,
  proof,
  now,
}: {
  key: string;
  formId: string;
  email: string;
  proof: string | null | undefined;
  now: Date;
}) => {
  const parsed = proof ? parseSignedToken(proof) : null;

  if (!parsed || !isSameHex(parsed.signature, sign(key, 'verified', [formId, email.toLowerCase(), parsed.issuedAt]))) {
    return false;
  }

  const age = now.getTime() - parsed.issuedAt;

  return age >= 0 && age <= PUBLIC_FORM_VERIFIED_PROOF_MAX_AGE_MS;
};

/**
 * The code secret has its own identity prefix, so a code for a form can never be used as a
 * document two-factor code and the reverse.
 */
const getPublicFormCodeSecret = ({ key, formId, email }: { key: string; formId: string; email: string }) =>
  hmac(sha256, key, `st-public-form-code|v1|email:${email.toLowerCase()}|form:${formId}`);

/**
 * Solid Ten Sign (RT4-M3): `generation` counts the codes of this form and address that were
 * already used. After a use the next request gives a fresh code, so a visitor is never sent
 * a code that is already spent. Generation 0 is the code as before.
 */
export const getPublicFormHotpCounter = (counter: number, generation = 0) => counter + generation * 2 ** 32;

export const generatePublicFormCode = async ({
  key,
  formId,
  email,
  now,
  generation = 0,
}: {
  key: string;
  formId: string;
  email: string;
  now: Date;
  generation?: number;
}) => {
  const counter = Math.floor(now.getTime() / PUBLIC_FORM_CODE_PERIOD_MS);

  return await generateHOTP(
    getPublicFormCodeSecret({ key, formId, email }),
    getPublicFormHotpCounter(counter, generation),
  );
};

/**
 * Solid Ten Sign (RT1-M3): the time step a code belongs to, or null when the code is not
 * valid now. The caller marks that step used, so one code verifies once.
 */
export const findPublicFormCodeCounter = async ({
  key,
  formId,
  email,
  code,
  now,
  generation = 0,
}: {
  key: string;
  formId: string;
  email: string;
  code: string;
  now: Date;
  generation?: number;
}): Promise<number | null> => {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const secret = getPublicFormCodeSecret({ key, formId, email });
  const currentCounter = Math.floor(now.getTime() / PUBLIC_FORM_CODE_PERIOD_MS);

  for (let step = 0; step < PUBLIC_FORM_CODE_WINDOW; step++) {
    const expected = await generateHOTP(secret, getPublicFormHotpCounter(currentCounter - step, generation));

    if (isSameHex(expected, code)) {
      return currentCounter - step;
    }
  }

  return null;
};

export const isPublicFormCodeValid = async ({
  key,
  formId,
  email,
  code,
  now,
}: {
  key: string;
  formId: string;
  email: string;
  code: string;
  now: Date;
}) => {
  if (!/^\d{6}$/.test(code)) {
    return false;
  }

  const secret = getPublicFormCodeSecret({ key, formId, email });
  const currentCounter = Math.floor(now.getTime() / PUBLIC_FORM_CODE_PERIOD_MS);

  for (let step = 0; step < PUBLIC_FORM_CODE_WINDOW; step++) {
    const expected = await generateHOTP(secret, currentCounter - step);

    if (isSameHex(expected, code)) {
      return true;
    }
  }

  return false;
};

/**
 * The `where` of the update that takes a submission slot. The update only matches while the
 * stored count is below the cap. Postgres re-checks that condition after it waits for a
 * concurrent update of the same row, so two requests can never take the same last slot.
 */
export const buildSubmissionSlotWhere = (formId: string, maxSubmissions: number | null) =>
  maxSubmissions === null ? { id: formId } : { id: formId, submissionCount: { lt: maxSubmissions } };

export type UnverifiedFormBlocker = 'OTHER_RECIPIENTS' | 'NEXT_SIGNER_DICTATION' | null;

/**
 * A form that does not verify the submitter's email may not make the server send mail to
 * anyone else: not to other recipients or CCs on the template, and not to a next signer the
 * submitter types in. Otherwise a stranger could use the form to send our mail to anyone.
 */
export const getUnverifiedFormBlocker = ({
  recipientIds,
  directRecipientId,
  allowDictateNextSigner,
}: {
  recipientIds: number[];
  directRecipientId: number;
  allowDictateNextSigner: boolean;
}): UnverifiedFormBlocker => {
  if (recipientIds.some((id) => id !== directRecipientId)) {
    return 'OTHER_RECIPIENTS';
  }

  if (allowDictateNextSigner) {
    return 'NEXT_SIGNER_DICTATION';
  }

  return null;
};
