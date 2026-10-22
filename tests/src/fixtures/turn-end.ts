/**
 * A session whose turns a flow opens and ends from the sandbox side, with a
 * known prompter (KRTX-1742 design §9). The local profile runs no sandbox, so
 * this seeds in SQL what a real prompt leaves behind and then speaks the
 * daemon's relay with the session's own sandbox credential (the SESS-35 token):
 *
 * - `project_sessions`: the session, created by `creator`;
 * - `session_sandboxes`: its active box, `sandbox_id == session_id`;
 * - per turn, the `continue_session` row `POST /prompts` writes for a person
 *   (`bindTurnIdentity`, forwarded under the wire message id) and the box's
 *   `activeTurns` entry for that message on runtime session `ses_root`.
 */
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { mintAccountToken, type Client } from '../core/client';
import type { Env } from '../core/env';
import type { FlowContext, Principal } from '../core/types';

/** A pg connection to the target database (TLS off only for a local one). */
export async function openFlowDb(env: Env): Promise<PgClient> {
  const url = env.databaseUrl;
  if (!url) throw new Error('KE2E_DATABASE_URL is required to seed a turn');
  const local = url.includes('localhost') || url.includes('127.0.0.1');
  const db = new PgClient({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  // A dropped connection must fail the next query, not crash the runner.
  db.on('error', () => {});
  await db.connect();
  return db;
}

export interface TurnSession {
  sessionId: string;
  /** The session sandbox's own credential: `/turn-stream`, `/turn-question`, `/turn-permission`. */
  sandbox: Client;
  /** Opens a running turn for `messageId`, prompted by `prompterUserId` when given. */
  startTurn(messageId: string, prompterUserId?: string): Promise<void>;
  /** The daemon reports the turn idle; asserts it closed that turn and promoted no queued prompt. */
  endTurn(messageId: string): Promise<void>;
  /** Deletes every row the seed and the relays wrote for the session. */
  cleanup(): Promise<void>;
}

/**
 * The SQL bind of a seeded turn session: the session row (created by the
 * creator), its active box (`sandbox_id == session_id`), and the SESS-35 token
 * re-own that makes the minted token the session sandbox's credential. On any
 * failure the partial rows are removed, so a retry seeds from a clean slate.
 */
async function bindTurnSession(
  db: PgClient,
  ids: { sessionId: string; accountId: string; projectId: string; creatorId: string },
  tokenId: string,
  metadata: Record<string, unknown>,
  visibility: 'private' | 'project',
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
       VALUES ($1, $2, $3, 'session/' || $1, 'kortix', 'running', $4, $5, $6::jsonb)`,
      [ids.sessionId, ids.accountId, ids.projectId, ids.creatorId, visibility, JSON.stringify({ name: 'Refactor the billing page', source: 'ui', ...metadata })],
    );
    await db.query(
      `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, metadata)
       VALUES ($1::uuid, $1, $2, $3, 'active', '{"activeTurns":{}}'::jsonb)`,
      [ids.sessionId, ids.accountId, ids.projectId],
    );
    // SESS-35: a token bound to the session is that session sandbox's credential.
    await db.query(
      'UPDATE kortix.account_tokens SET account_id = $2, user_id = $3, project_id = $4, session_id = $5 WHERE token_id = $1',
      [tokenId, ids.accountId, ids.creatorId, ids.projectId, ids.sessionId],
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * What a person's prompt leaves behind (KRTX-1742 design §9): the
 * `continue_session` row `POST /prompts` writes (forwarded under the wire
 * message id, `bindTurnIdentity`), and the box's `activeTurns` entry for that
 * message on runtime session `ses_root`.
 */
async function seedTurnStart(
  db: PgClient,
  ids: { sessionId: string; accountId: string; projectId: string },
  messageId: string,
  prompterUserId?: string,
): Promise<void> {
  if (prompterUserId) {
    await db.query(
      `INSERT INTO kortix.session_lifecycle_commands
         (command_type, source, status, project_id, session_id, account_id, actor_user_id, payload, result)
       VALUES ('continue_session', 'ui', 'succeeded', $1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        ids.projectId,
        ids.sessionId,
        ids.accountId,
        prompterUserId,
        JSON.stringify({ clientMessageId: messageId, wireMessageId: messageId, bindTurnIdentity: true }),
        JSON.stringify({ status: 'forwarded', forwarded_message_id: messageId }),
      ],
    );
  }
  const token = `turn-${messageId}`;
  await db.query(
    `UPDATE kortix.session_sandboxes
        SET metadata = jsonb_set(metadata, ARRAY['activeTurns', $2::text], $3::jsonb)
      WHERE sandbox_id = $1::uuid`,
    [
      ids.sessionId,
      token,
      JSON.stringify({ token, state: 'active', messageId, runtimeSessionId: 'ses_root', startedAtMs: Date.now() }),
    ],
  );
}

export async function seedTurnSession(
  ctx: FlowContext,
  db: PgClient,
  input: {
    projectId: string;
    accountId: string;
    creator: Principal;
    metadata?: Record<string, unknown>;
    visibility?: 'private' | 'project';
  },
): Promise<TurnSession> {
  const { projectId, accountId } = input;
  const creatorId = input.creator.userId;
  if (!creatorId) throw new Error('the session creator has no userId');
  const sessionId = randomUUID();
  const { token_id: tokenId, secret_key: secret } = await mintAccountToken(
    ctx.client.as(input.creator),
    `turn ${sessionId.slice(0, 8)}`,
  );

  const cleanup = async () => {
    for (const table of [
      'notifications',
      'notification_watchers',
      'session_presence_leases',
      'session_pending_questions',
      'permission_push_claims',
      'session_turns',
      'session_lifecycle_commands',
      'session_sandboxes',
      'project_sessions',
    ]) {
      await db.query(`DELETE FROM kortix.${table} WHERE session_id = $1`, [sessionId]).catch(() => {});
    }
    await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [tokenId]).catch(() => {});
  };

  await bindTurnSession(
    db,
    { sessionId, accountId, projectId, creatorId },
    tokenId,
    input.metadata ?? {},
    input.visibility ?? 'project',
    cleanup,
  );

  const sandbox = ctx.client.withBearer(secret, 'SESSION_SANDBOX');
  return {
    sessionId,
    sandbox,
    async startTurn(messageId, prompterUserId) {
      await seedTurnStart(db, { sessionId, accountId, projectId }, messageId, prompterUserId);
    },
    async endTurn(messageId) {
      const ended = await sandbox.post(
        '/v1/projects/:projectId/turn-stream',
        { session_id: sessionId, kind: 'end', status: 'idle', runtime_session_id: 'ses_root', turn_message_id: messageId },
        { params: { projectId } },
      );
      // Only an end that closed a turn and promoted nothing notifies anyone.
      ended.status(200).body().has('$.turn_completion.outcome', 'closed').has('$.queue_promoted', false);
    },
    cleanup,
  };
}
