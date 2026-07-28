import { randomUUID } from 'node:crypto';
import type { Env } from '../core/env';
import type { CreatedProject } from '../core/types';

interface ProjectDb {
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type OpenProjectDb = (databaseUrl: string) => Promise<ProjectDb>;

async function openProjectDb(databaseUrl: string): Promise<ProjectDb> {
  const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const { Client } = await import('pg');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

function assertDatabaseFixtureAllowed(env: Env, action: string): string {
  if (env.target === 'prod') {
    throw new Error(`refusing to ${action} a database-only project against production`);
  }
  if (!env.databaseUrl) {
    throw new Error('KE2E_DATABASE_URL is required for database-only project fixtures');
  }
  return env.databaseUrl;
}

export async function createDatabaseProject(
  env: Env,
  input: {
    accountId: string;
    userId: string;
    name: string;
  },
  open: OpenProjectDb = openProjectDb,
): Promise<CreatedProject> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, 'create');
  const projectId = randomUUID();
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
           'https://ke2e.invalid/' || $1::text || '.git',
           'main',
           'kortix.yaml',
           'active'::kortix.project_status,
           '{"ke2e":{"database_only":true}}'::jsonb
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
      [projectId, input.accountId, input.userId, input.name],
    );
  } finally {
    await client.end();
  }
  return { id: projectId, name: input.name };
}

export async function deleteDatabaseProject(
  env: Env,
  projectId: string,
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, 'delete');
  const client = await open(databaseUrl);
  try {
    await client.query(
      `DELETE FROM kortix.projects
       WHERE project_id = $1::uuid`,
      [projectId],
    );
  } finally {
    await client.end();
  }
}
