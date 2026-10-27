import { Client, type QueryResultRow } from "pg";

import { requireEnvValue } from "./env";

export async function runDatabaseSql(
  sql: string,
  values: unknown[] = [],
  databaseUrl?: string,
): Promise<void> {
  await queryDatabaseRows(sql, values, databaseUrl);
}

export async function queryDatabaseRows<
  T extends QueryResultRow = QueryResultRow,
>(sql: string, values: unknown[] = [], databaseUrl?: string): Promise<T[]> {
  const connectionString =
    databaseUrl ??
    process.env.KE2E_DATABASE_URL ??
    process.env.E2E_DATABASE_URL ??
    requireEnvValue("DATABASE_URL", "apps/api/.env.local", "apps/api/.env");
  const client = new Client({ connectionString });
  // A dropped connection must fail the next query, not crash the runner.
  client.on('error', () => {});
  await client.connect();
  try {
    const result = await client.query<T>(sql, values);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * The same query, retried until it returns at least one row.
 *
 * A browser journey that acts through the UI and then reads the database is
 * racing two independent systems: the API commits the row after the response
 * the browser already rendered. Polling is the only sound wait — a fixed sleep
 * is either flaky or slow, and the browser exposes no event for "the server
 * finished writing".
 *
 * Returns the last (possibly empty) result when the budget runs out, so the
 * caller's own `expect` still reports what it actually wanted.
 */
export async function pollDatabaseRows<
  T extends QueryResultRow = QueryResultRow,
>(
  sql: string,
  values: unknown[] = [],
  {
    timeoutMs = 20_000,
    intervalMs = 500,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: T[] = [];
  for (;;) {
    rows = await queryDatabaseRows<T>(sql, values).catch(() => [] as T[]);
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

