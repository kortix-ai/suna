import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";

import { requireEnvValue } from "./env";

function escapeSql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

interface SeedProjectOptions {
  accountId: string;
  userId: string;
  name: string;
  repoUrl?: string;
  projectRole?: "manager" | "member";
}

export async function runDatabaseSql(
  sql: string,
  values: unknown[] = [],
): Promise<void> {
  await queryDatabaseRows(sql, values);
}

export async function queryDatabaseRows<
  T extends QueryResultRow = QueryResultRow,
>(sql: string, values: unknown[] = []): Promise<T[]> {
  const databaseUrl = requireEnvValue(
    "DATABASE_URL",
    "apps/api/.env.local",
    "apps/api/.env",
  );
  const client = new Client({ connectionString: databaseUrl });
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
export async function pollDatabaseRows<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
  { timeoutMs = 20_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: T[] = [];
  for (;;) {
    rows = await queryDatabaseRows<T>(sql, values).catch(() => [] as T[]);
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function seedDatabaseProject({
  accountId,
  userId,
  name,
  repoUrl,
  projectRole = "manager",
}: SeedProjectOptions): Promise<string> {
  const projectId = randomUUID();
  const projectRepoUrl =
    repoUrl ?? `https://github.com/kortix-ai/browser-${projectId}.git`;
  await runDatabaseSql(`
insert into kortix.projects (
  project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata
) values (
  '${projectId}'::uuid,
  '${escapeSql(accountId)}'::uuid,
  '${escapeSql(name)}',
  '${escapeSql(projectRepoUrl)}',
  'main',
  'kortix.yaml',
  'active',
  '{"browser_test":true,"onboarding_completed_at":"2026-01-01T00:00:00.000Z"}'::jsonb
);

insert into kortix.project_members (
  account_id, project_id, user_id, project_role, granted_by
) values (
  '${escapeSql(accountId)}'::uuid,
  '${projectId}'::uuid,
  '${escapeSql(userId)}'::uuid,
  '${escapeSql(projectRole)}',
  '${escapeSql(userId)}'::uuid
);
`);
  return projectId;
}
