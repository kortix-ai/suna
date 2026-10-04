import { randomUUID } from "node:crypto";
import type { Env } from "../core/env";
import type { CreatedProject, FlowContext } from "../core/types";

export interface ProjectDb {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export type OpenProjectDb = (databaseUrl: string) => Promise<ProjectDb>;

async function openProjectDb(databaseUrl: string): Promise<ProjectDb> {
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
      `refusing to ${action} a database-only project against production`,
    );
  }
  if (!env.databaseUrl) {
    throw new Error(
      "KE2E_DATABASE_URL is required for database-only project fixtures",
    );
  }
  return env.databaseUrl;
}

/** Open the database-only project fixture connection for `action`, prod-guarded. */
export async function openProjectDatabase(
  env: Env,
  action: string,
): Promise<ProjectDb> {
  return openProjectDb(assertDatabaseFixtureAllowed(env, action));
}

/**
 * The canonical raw pg connection for flows: the local profile connects without
 * TLS, anything else with an unverified certificate (self-signed test origins).
 */
export async function openDb(ctx: FlowContext): Promise<ProjectDb> {
  const databaseUrl = ctx.env.databaseUrl;
  if (!databaseUrl) throw new Error('AGP fixtures need KE2E_DATABASE_URL (requires: database)');
  return openProjectDb(databaseUrl);
}

/**
 * Run `fn` against a bare no-TLS pg connection, open and closed for the call.
 * Deliberately NOT `openDb`: several flows read stored transcript rows exactly
 * the way the API's mirror does, without the ssl option.
 */
export async function withDb<T>(
  env: Env,
  fn: (db: ProjectDb) => Promise<T>,
): Promise<T> {
  if (!env.databaseUrl) {
    throw new Error("KE2E_DATABASE_URL is required for database-only project fixtures");
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** One live sandbox row for a database-only session (what a running session has). */
export async function insertActiveSessionSandbox(
  db: ProjectDb,
  input: { sessionId: string; accountId: string; projectId: string },
): Promise<void> {
  await db.query(
    "INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')",
    [input.sessionId, input.accountId, input.projectId],
  );
}

/**
 * Bind a minted account token to one database-only session with the agent grant
 * its sandbox would run with; `serviceAccountId` names the agent's service
 * account when the token row carries one.
 */
export async function bindAgentGrantToToken(
  db: ProjectDb,
  input: {
    tokenId: string;
    accountId: string;
    projectId: string;
    sessionId: string;
    grant: Record<string, unknown>;
    serviceAccountId?: string;
  },
): Promise<void> {
  const serviceAccount = input.serviceAccountId ? ', service_account_id = $6' : '';
  await db.query(
    `UPDATE kortix.account_tokens
        SET project_id = $2, session_id = $3, agent_grant = $4::jsonb, account_id = $5${serviceAccount}
      WHERE token_id = $1`,
    [
      input.tokenId,
      input.projectId,
      input.sessionId,
      JSON.stringify(input.grant),
      input.accountId,
      ...(input.serviceAccountId ? [input.serviceAccountId] : []),
    ],
  );
}

export async function createDatabaseProject(
  env: Env,
  input: {
    accountId: string;
    userId: string;
    name: string;
    repoUrl?: string | null;
    appsEnabled?: boolean;
    metadata?: Record<string, unknown>;
  },
  open: OpenProjectDb = openProjectDb,
): Promise<CreatedProject> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "create");
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
        projectId,
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
  return { id: projectId, name: input.name };
}

export async function setDatabaseEnterpriseDemo(
  env: Env,
  accountId: string,
  enabled: boolean,
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "update enterprise demo for");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `INSERT INTO kortix.credit_accounts (account_id, demo_enterprise)
       VALUES ($1::uuid, $2)
       ON CONFLICT (account_id)
       DO UPDATE SET demo_enterprise = EXCLUDED.demo_enterprise`,
      [accountId, enabled],
    );
  } finally {
    await client.end();
  }
}

/** Record a failed run on a trigger, as the API does when a trigger session's turn ends with an error. */
export async function setDatabaseTriggerRunFailed(
  env: Env,
  input: { projectId: string; slug: string; error: string },
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "fail a trigger run for");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `UPDATE kortix.project_trigger_runtime
          SET last_status = 'failed', last_error = $3, last_attempt_at = now(), updated_at = now()
        WHERE project_id = $1::uuid AND slug = $2`,
      [input.projectId, input.slug, input.error],
    );
  } finally {
    await client.end();
  }
}

export async function fundDatabaseAccount(
  env: Env,
  accountId: string,
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "fund account for");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `INSERT INTO kortix.credit_accounts (
         account_id, balance, balance_precise,
         non_expiring_credits, non_expiring_credits_precise, tier
       ) VALUES ($1::uuid, 1000, 1000, 1000, 1000, 'tier_2_20')
       ON CONFLICT (account_id) DO UPDATE SET
         balance = 1000,
         balance_precise = 1000,
         non_expiring_credits = 1000,
         non_expiring_credits_precise = 1000,
         tier = 'tier_2_20'`,
      [accountId],
    );
  } finally {
    await client.end();
  }
}

export async function mergeDatabaseProjectMetadata(
  env: Env,
  projectId: string,
  metadata: Record<string, unknown>,
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "update metadata for");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `UPDATE kortix.projects
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE project_id = $1::uuid`,
      [projectId, JSON.stringify(metadata)],
    );
  } finally {
    await client.end();
  }
}

export async function createDatabaseSession(
  env: Env,
  input: {
    projectId: string;
    accountId: string;
    userId: string;
    visibility?: "private" | "project" | "restricted";
    metadata?: Record<string, unknown>;
    /** Provider-reported placement, with the runtime still unready. */
    platinumRegion?: string;
    parentSessionId?: string;
    initiator?: { type: "member" | "trigger" | "channel" | "api" | "system"; id: string | null };
  },
  open: OpenProjectDb = openProjectDb,
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
         created_by,
         visibility,
         metadata,
         parent_session_id,
         initiator_type,
         initiator_id
       )
       VALUES (
         $1,
         $2::uuid,
         $3::uuid,
         'session/' || $1,
         $4::uuid,
         $5::kortix.project_session_visibility,
         $6::jsonb,
         $7,
         $8::kortix.project_session_initiator,
         $9
       )`,
      [
        sessionId,
        input.accountId,
        input.projectId,
        input.userId,
        input.visibility ?? "private",
        JSON.stringify({
          ...(input.metadata ?? {}),
          ...(input.parentSessionId ? { spawned_by_session: input.parentSessionId } : {}),
        }),
        input.parentSessionId ?? null,
        input.initiator?.type ?? "member",
        input.initiator ? input.initiator.id : input.userId,
      ],
    );
    if (input.platinumRegion) {
      await client.query(
        `INSERT INTO kortix.session_sandboxes (
           sandbox_id, session_id, account_id, project_id, provider, status, config, metadata
         ) VALUES ($1::uuid, $1, $2::uuid, $3::uuid, 'platinum', 'provisioning', '{}'::jsonb, $4::jsonb)`,
        [sessionId, input.accountId, input.projectId, JSON.stringify({ platinumRegion: input.platinumRegion })],
      );
    }
  } finally {
    await client.end();
  }
  return sessionId;
}

/**
 * Reproduce a repository replacement without calling GitHub. The fixture pins
 * the project and session to different generations and can retain one inert
 * sandbox identity for the preserved-workspace start contract.
 */
export async function configurePreviousRepositorySession(
  env: Env,
  input: {
    projectId: string;
    sessionId: string;
    accountId: string;
    preserveRuntime: boolean;
  },
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "configure previous-repository session for");
  const client = await open(databaseUrl);
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE kortix.projects
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"repository_generation":"generation-current"}'::jsonb
       WHERE project_id = $1::uuid`,
      [input.projectId],
    );
    await client.query(
      `UPDATE kortix.project_sessions
       SET status = 'stopped',
           sandbox_provider = 'daytona',
           metadata = COALESCE(metadata, '{}'::jsonb) || '{"repository_generation":"generation-previous"}'::jsonb
       WHERE session_id = $1 AND project_id = $2::uuid`,
      [input.sessionId, input.projectId],
    );
    if (input.preserveRuntime) {
      await client.query(
        `INSERT INTO kortix.session_sandboxes (
           sandbox_id, session_id, account_id, project_id, provider, external_id, status, config, metadata
         ) VALUES ($1::uuid, $1, $2::uuid, $3::uuid, 'daytona', $4, 'error', '{}'::jsonb, '{}'::jsonb)
         ON CONFLICT (sandbox_id) DO UPDATE
         SET external_id = EXCLUDED.external_id, status = EXCLUDED.status`,
        [input.sessionId, input.accountId, input.projectId, `ke2e-preserved-${input.sessionId}`],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

/** Read one prompt attachment's retention state: remaining references, and whether the cleanup sweep may remove it now. */export async function readDatabasePromptAttachmentRetention(
  env: Env,
  attachmentId: string,
  open: OpenProjectDb = openProjectDb,
): Promise<{ references: number; due: boolean }> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "read attachment retention for");
  const client = await open(databaseUrl);
  try {
    const result = (await client.query(
      `SELECT
         (SELECT count(*)::int FROM kortix.prompt_attachment_references WHERE attachment_id = $1::uuid) AS "references",
         COALESCE((SELECT expires_at <= now() FROM kortix.prompt_attachments WHERE attachment_id = $1::uuid), true) AS due`,
      [attachmentId],
    )) as { rows: Array<{ references: number; due: boolean }> };
    return result.rows[0]!;
  } finally {
    await client.end();
  }
}

/** Bind a freshly minted project PAT to one synthetic live session for internal-route flows. */
export async function bindDatabaseSessionCredential(
  env: Env,
  input: {
    tokenId: string;
    commandId: string;
    sessionId: string;
    accountId: string;
    projectId: string;
  },
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "bind a session credential for");
  const client = await open(databaseUrl);
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO kortix.session_sandboxes (
         sandbox_id, session_id, account_id, project_id, status
       ) VALUES ($1::uuid, $1, $2::uuid, $3::uuid, 'provisioning')
       ON CONFLICT (sandbox_id) DO NOTHING`,
      [input.sessionId, input.accountId, input.projectId],
    );
    await client.query(
      `UPDATE kortix.account_tokens
       SET session_id = $2
       WHERE token_id = $1::uuid`,
      [input.tokenId, input.sessionId],
    );
    await client.query(
      `UPDATE kortix.session_lifecycle_commands
       SET status = 'running', locked_until = now() + interval '10 minutes'
       WHERE command_id = $1::uuid`,
      [input.commandId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

export async function deleteDatabaseProject(
  env: Env,
  projectId: string,
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "delete");
  const client = await open(databaseUrl);
  try {
    // Apps first: an App delete is soft, so its deployment rows survive it, and
    // `app_deployments.artifact_id` RESTRICTs the artifact delete the project
    // cascade would otherwise attempt first. Deleting the apps cascades the
    // deployments away before the project row goes.
    await client.query(
      `DELETE FROM kortix.apps
       WHERE project_id = $1::uuid`,
      [projectId],
    );
    await client.query(
      `DELETE FROM kortix.projects
       WHERE project_id = $1::uuid`,
      [projectId],
    );
  } finally {
    await client.end();
  }
}

/**
 * A running session with a live sandbox row and a session-bound credential,
 * the shape a sandbox's own KORTIX_TOKEN has. The token is minted as a plain
 * PAT and bound in the database, so it carries no agent grant — the shape of a
 * session in a project that declares no agents.
 */
export async function seedBoundSession(
  ctx: FlowContext,
  db: ProjectDb,
  project: { id: string; accountId?: string },
  label: string,
  visibility: 'private' | 'project' | 'restricted' = 'private',
): Promise<{ sessionId: string; tokenId: string; token: string }> {
  const ownerUserId = ctx.P.OWNER.userId!;
  const accountId = project.accountId ?? ctx.P.OWNER.accountId!;
  const sessionId = randomUUID();
  const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', { name: `${label} ${sessionId.slice(0, 8)}` });
  minted.status(201);
  const credential = minted.json<{ token_id: string; secret_key: string }>();
  await db.query(
    `INSERT INTO kortix.project_sessions
       (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility)
     VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4, $5::kortix.project_session_visibility)`,
    [sessionId, accountId, project.id, ownerUserId, visibility],
  );
  await db.query(
    `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
     VALUES ($1::uuid, $1, $2, $3, 'active')`,
    [sessionId, accountId, project.id],
  );
  await db.query(
    `UPDATE kortix.account_tokens
        SET account_id = $2, user_id = $3, project_id = $4, session_id = $5
      WHERE token_id = $1`,
    [credential.token_id, accountId, ownerUserId, project.id, sessionId],
  );
  return { sessionId, tokenId: credential.token_id, token: credential.secret_key };
}

export async function dropBoundSession(
  db: ProjectDb,
  seeded: { sessionId: string; tokenId: string } | null,
): Promise<void> {
  if (!seeded) return;
  await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [seeded.tokenId]).catch(() => {});
  await db.query('DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1::uuid', [seeded.sessionId]).catch(() => {});
  await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [seeded.sessionId]).catch(() => {});
}
