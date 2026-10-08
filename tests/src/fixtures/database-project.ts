import { randomUUID } from "node:crypto";
import type { Env } from "../core/env";
import type { CreatedProject } from "../core/types";

interface ProjectDb {
  query(text: string, values?: unknown[]): Promise<unknown>;
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

/**
 * Set one feature-flag override on a project row, as the operator route
 * (`PUT /v1/admin/api/projects/:id/features`) does. For browser journeys that
 * need an internal-only flag (`apps`, `backends`): a project owner cannot
 * write those through `PATCH /projects/:id/features`.
 */
export async function setDatabaseProjectFeature(
  env: Env,
  projectId: string,
  feature: string,
  enabled: boolean,
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "set a feature flag for");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `UPDATE kortix.projects
       SET metadata = coalesce(metadata, '{}'::jsonb)
         || jsonb_build_object('experimental', coalesce(metadata->'experimental', '{}'::jsonb) || jsonb_build_object($2::text, $3::boolean)),
         updated_at = now()
       WHERE project_id = $1::uuid`,
      [projectId, feature, enabled],
    );
  } finally {
    await client.end();
  }
}

/** Record a failed run on a trigger, as the API does when a trigger session's turn ends with an error. */
/**
 * The session's first prompt, claimed and on its way (`running`, locked for
 * 10 minutes). Every prompt sent after it waits behind it
 * (`older_prompt_pending`), so a local run can drive the queued-prompt routes
 * without a sandbox. The row runs as `userId`.
 */
export async function seedDatabaseRunningFirstPrompt(
  env: Env,
  input: { projectId: string; sessionId: string; accountId: string; userId: string },
  open: OpenProjectDb = openProjectDb,
): Promise<void> {
  const databaseUrl = assertDatabaseFixtureAllowed(env, "seed a running prompt for");
  const client = await open(databaseUrl);
  try {
    await client.query(
      `INSERT INTO kortix.session_lifecycle_commands
         (command_type, source, status, project_id, session_id, account_id,
          actor_user_id, idempotency_key, payload, result, locked_by, locked_until)
       VALUES ('continue_session', 'ui', 'running', $1, $2, $3, $4, $5, $6::jsonb,
         $7::jsonb, 'ke2e-first-prompt-fixture', now() + interval '10 minutes')`,
      [
        input.projectId,
        input.sessionId,
        input.accountId,
        input.userId,
        `prompt:${input.sessionId}:pending-first`,
        JSON.stringify({
          text: "first prompt",
          clientMessageId: `pending:${input.sessionId}`,
          remintOnDelivery: true,
          parts: [{ type: "text", text: "first prompt" }],
        }),
        JSON.stringify({ delivery_started_at: new Date().toISOString() }),
      ],
    );
  } finally {
    await client.end();
  }
}

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

/** Read one prompt attachment's retention state: remaining references, and whether the cleanup sweep may remove it now. */
export async function readDatabasePromptAttachmentRetention(
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
