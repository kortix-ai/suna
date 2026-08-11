import { randomUUID } from "node:crypto";
import type { Env } from "../core/env";
import type { CreatedWorkspace } from "../core/types";

interface WorkspaceDb {
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type OpenWorkspaceDb = (databaseUrl: string) => Promise<WorkspaceDb>;

async function openWorkspaceDb(databaseUrl: string): Promise<WorkspaceDb> {
  const local =
    databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1");
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: databaseUrl,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

function assertDatabaseFixtureAllowed(env: Env, action: string): string {
  if (env.target === "prod") {
    throw new Error(
      `refusing to ${action} a database-only workspace against production`,
    );
  }
  if (!env.databaseUrl) {
    throw new Error(
      "KE2E_DATABASE_URL is required for database-only workspace fixtures",
    );
  }
  return env.databaseUrl;
}

export async function createDatabaseWorkspace(
  env: Env,
  input: {
    accountId: string;
    userId: string;
    name: string;
    repoUrl?: string | null;
    appsEnabled?: boolean;
    metadata?: Record<string, unknown>;
  },
  open: OpenWorkspaceDb = openWorkspaceDb,
): Promise<CreatedWorkspace> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "create");
  const workspaceId = randomUUID();
  const client = await open(databaseUrl);
  try {
    await client.query(
      `WITH inserted_project AS (
         INSERT INTO kortix.projects (
           project_id,
           account_id,
           name,
           repo_url,
           default_branch,
           manifest_path,
           status,
           metadata
         )
         VALUES (
           $1::uuid,
           $2::uuid,
           $4,
           COALESCE($5, 'https://ke2e.invalid/' || $1::text || '.git'),
           'main',
           'kortix.yaml',
           'active'::kortix.project_status,
           $6::jsonb
         )
         RETURNING project_id
       )
       INSERT INTO kortix.project_members (
         account_id,
         project_id,
         user_id,
         project_role,
         granted_by
       )
       SELECT
         $2::uuid,
         project_id,
         $3::uuid,
         'manager'::kortix.project_role,
         $3::uuid
       FROM inserted_project`,
      [
        workspaceId,
        input.accountId,
        input.userId,
        input.name,
        input.repoUrl ?? null,
        JSON.stringify({
          ke2e: { database_only: true },
          experimental: { apps: input.appsEnabled ?? true },
          onboarding_completed_at: "2026-01-01T00:00:00.000Z",
          ...(input.metadata ?? {}),
        }),
      ],
    );
  } finally {
    await client.end();
  }
  return { id: workspaceId, name: input.name };
}

export async function mergeDatabaseWorkspaceMetadata(
  env: Env,
  workspaceId: string,
  metadata: Record<string, unknown>,
  open: OpenWorkspaceDb = openWorkspaceDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "update metadata for");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `UPDATE kortix.projects
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE project_id = $1::uuid`,
      [workspaceId, JSON.stringify(metadata)],
    );
  } finally {
    await client.end();
  }
}

export async function createDatabaseSession(
  env: Env,
  input: {
    workspaceId: string;
    accountId: string;
    userId: string;
  },
  open: OpenWorkspaceDb = openWorkspaceDb,
): Promise<string> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "create a session for");
  const sessionId = randomUUID();
  const client = await open(databaseUrl);
  try {
    await client.query(
      `INSERT INTO kortix.project_sessions (
         session_id,
         account_id,
         project_id,
         branch_name,
         created_by
       )
       VALUES (
         $1,
         $2::uuid,
         $3::uuid,
         'session/' || $1,
         $4::uuid
       )`,
      [sessionId, input.accountId, input.workspaceId, input.userId],
    );
  } finally {
    await client.end();
  }
  return sessionId;
}

export async function deleteDatabaseWorkspace(
  env: Env,
  workspaceId: string,
  open: OpenWorkspaceDb = openWorkspaceDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "delete");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `DELETE FROM kortix.projects
       WHERE project_id = $1::uuid`,
      [workspaceId],
    );
  } finally {
    await client.end();
  }
}

/** @deprecated Use OpenWorkspaceDb. */
export type OpenProjectDb = OpenWorkspaceDb;
/** @deprecated Use createDatabaseWorkspace. */
export const createDatabaseProject = createDatabaseWorkspace;
/** @deprecated Use mergeDatabaseWorkspaceMetadata. */
export const mergeDatabaseProjectMetadata = mergeDatabaseWorkspaceMetadata;
/** @deprecated Use deleteDatabaseWorkspace. */
export const deleteDatabaseProject = deleteDatabaseWorkspace;
