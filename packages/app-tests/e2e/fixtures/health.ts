/**
 * Solid Ten Sign (R, test maintenance): the /api/health detail is shown to monitoring only. A
 * stack with NEXT_PRIVATE_ST_HEALTH_TOKEN set (production-like) wants that token; specs that read
 * the detail send it when the test environment has it, as monitoring does.
 */
export const healthHeaders = (): Record<string, string> => {
  const token = process.env.NEXT_PRIVATE_ST_HEALTH_TOKEN;

  return token ? { Authorization: `Bearer ${token}` } : {};
};
