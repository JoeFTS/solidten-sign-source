/**
 * Solid Ten Sign (AUD-15): the most calls one tRPC HTTP request may carry.
 * The server refuses a larger batch; the web client's batch link splits at
 * the same number, so normal pages never hit the limit.
 */
export const TRPC_MAX_BATCH_SIZE = 20;
