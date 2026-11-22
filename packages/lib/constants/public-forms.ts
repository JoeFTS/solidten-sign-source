import { env } from '../utils/env';

/**
 * Public form settings can be changed unless `NEXT_PUBLIC_ST_PUBLIC_FORMS_ENABLED` is "false".
 * Turning it off never turns protections off: forms keep their dates, caps, email
 * verification and abuse checks, and senders can still close a form.
 */
export const IS_PUBLIC_FORMS_ENABLED = () => env('NEXT_PUBLIC_ST_PUBLIC_FORMS_ENABLED') !== 'false';
