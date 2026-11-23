import { AppError, type AppErrorCode } from './app-error';

/**
 * Solid Ten Sign (N-3): a refusal a signer or sender may read. The message is plain and holds no
 * internal ids; the ids go to the server log only.
 */
export const plainRefusal = (
  code: AppErrorCode | string,
  message: string,
  logDetail: Record<string, unknown>,
  options: { statusCode?: number } = {},
) => {
  console.warn(`[refusal] ${code}: ${message}`, JSON.stringify(logDetail));

  return new AppError(code, { message, ...options });
};
