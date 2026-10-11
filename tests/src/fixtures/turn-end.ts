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
import type { Client } from '../core/client';
import type { Env } from '../core/env';
import type { FlowContext, Principal } from '../core/types';

/** A pg connection to the target database (TLS off only for a local one). */
export async function openFlowDb(env: Env): Promise<PgClient> {
  const url = env.databaseUrl;
  if (!url) throw new Error('KE2E_DATABASE_URL is required to seed a turn');
  const local = url.includes('localhost') || url.includes('127.0.0.1');
  const db = new PgClient({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
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
  const minted = await ctx.client.as(input.creator).post('/v1/accounts/tokens', { name: `turn ${sessionId.slice(0, 8)}` });
  minted.status(201);
  const { token_id: tokenId, secret_key: secret } = minted.json<{ token_id: string; secret_key: string }>();

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

  try {
    await db.query(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
       VALUES ($1, $2, $3, 'session/' || $1, 'kortix', 'running', $4, $5, $6::jsonb)`,
      [sessionId, accountId, projectId, creatorId, input.visibility ?? 'project', JSON.stringify({ name: 'Refactor the billing page', source: 'ui', ...input.metadata })],
    );
    await db.query(
      `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, metadata)
       VALUES ($1::uuid, $1, $2, $3, 'active', '{"activeTurns":{}}'::jsonb)`,
      [sessionId, accountId, projectId],
    );
    // SESS-35: a token bound to the session is that session sandbox's credential.
    await db.query(
      'UPDATE kortix.account_tokens SET account_id = $2, user_id = $3, project_id = $4, session_id = $5 WHERE token_id = $1',
      [tokenId, accountId, creatorId, projectId, sessionId],
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  const sandbox = ctx.client.withBearer(secret, 'SESSION_SANDBOX');
  return {
    sessionId,
    sandbox,
    async startTurn(messageId, prompterUserId) {
      if (prompterUserId) {
        await db.query(
          `INSERT INTO kortix.session_lifecycle_commands
             (command_type, source, status, project_id, session_id, account_id, actor_user_id, payload, result)
           VALUES ('continue_session', 'ui', 'succeeded', $1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [
            projectId,
            sessionId,
            accountId,
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
          sessionId,
          token,
          JSON.stringify({ token, state: 'active', messageId, runtimeSessionId: 'ses_root', startedAtMs: Date.now() }),
        ],
      );
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
