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
