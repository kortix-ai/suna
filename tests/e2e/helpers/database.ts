import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";

import { requireEnvValue } from "./env";

function escapeSql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

interface SeedWorkspaceOptions {
  accountId: string;
  userId: string;
  name: string;
  repoUrl?: string;
  workspaceRole?: "manager" | "editor" | "member";
  /** @deprecated Use workspaceRole. */
  projectRole?: "manager" | "editor" | "member";
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

export async function seedDatabaseWorkspace({
  accountId,
  userId,
  name,
  repoUrl,
  workspaceRole,
  projectRole,
}: SeedWorkspaceOptions): Promise<string> {
  const workspaceId = randomUUID();
  const workspaceRepoUrl =
    repoUrl ?? `https://github.com/kortix-ai/browser-${workspaceId}.git`;
  const role = workspaceRole ?? projectRole ?? "editor";
  await runDatabaseSql(`
insert into kortix.projects (
  project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata
) values (
  '${workspaceId}'::uuid,
  '${escapeSql(accountId)}'::uuid,
  '${escapeSql(name)}',
  '${escapeSql(workspaceRepoUrl)}',
  'main',
  'kortix.yaml',
  'active',
  '{"browser_test":true,"onboarding_completed_at":"2026-01-01T00:00:00.000Z"}'::jsonb
);

insert into kortix.project_members (
  account_id, project_id, user_id, project_role, granted_by
) values (
  '${escapeSql(accountId)}'::uuid,
  '${workspaceId}'::uuid,
  '${escapeSql(userId)}'::uuid,
  '${escapeSql(role)}',
  '${escapeSql(userId)}'::uuid
);
`);
  return workspaceId;
}

/** @deprecated Use seedDatabaseWorkspace. The database schema retains physical project identifiers. */
export const seedDatabaseProject = seedDatabaseWorkspace;
