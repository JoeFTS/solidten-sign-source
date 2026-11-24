import pg from 'pg';

/**
 * Solid Ten Sign (Q-1): run one statement with the database checks (triggers) off, to make a state
 * the checks now refuse, as old data may hold it (a broken direct link that is already on).
 */
export const runWithoutDbChecks = async (sql: string, params: unknown[] = []) => {
  const client = new pg.Client({ connectionString: process.env.NEXT_PRIVATE_DATABASE_URL });

  await client.connect();

  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query(sql, params);
  } finally {
    await client.end();
  }
};
