import { env } from '../utils/env';

/**
 * Conditional and calculated fields are on unless `NEXT_PUBLIC_ST_FIELD_LOGIC_ENABLED` is
 * "false". Turning it off stops senders from adding new rules; rules already stored on an
 * envelope keep being enforced, because dropping them would make hidden fields required.
 */
export const IS_FIELD_LOGIC_ENABLED = () => env('NEXT_PUBLIC_ST_FIELD_LOGIC_ENABLED') !== 'false';
