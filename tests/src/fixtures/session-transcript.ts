import { gzipSync } from 'node:zlib';
import * as sessionLogContract from '@kortix/api-contract/session-log';
import type { V1Row } from '@kortix/api-contract/session-log';
import { Client } from 'pg';
import type { Env } from '../core/env';

// Playwright loads the package as CommonJS, where its re-exported names sit on `default`;
// Bun reads them from the namespace.
const { fromV1 } =
  (sessionLogContract as { default?: typeof sessionLogContract }).default ?? sessionLogContract;

type SavedMessage = {
  info: { id: string; role: string; time: { created: number; completed?: number } } & Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
};

/**
 * A stopped session with saved history. By default the history is the v1 mirror
 * (`session_transcript_messages`), what every project reads today. With `log`, it is the
 * session log instead, written the way a box's daemon writes it: `fromV1` of the same rows
 * under producer `opencode`, posted to `POST …/log/journal` with a session sandbox
 * credential minted for the call; the project's `session_log` flag is turned on, so every
 * stored-transcript read serves the log (`readStoredTranscriptWindow`). No mirror row is
 * written then, so a read that passes proves the log answered.
 */
/**
 * The default prompt and reply a seeded transcript stores when the caller does
 * not bring its own: one user message and one assistant reply, ids fixed so a
 * test can address them.
 */
function defaultSavedMessages(root: string, created: number): SavedMessage[] {
  return [
    {
      info: {
        id: 'msg_000000000000000000000001',
        sessionID: root,
        role: 'user',
        time: { created },
        agent: 'kortix',
        model: { providerID: 'kortix', modelID: 'openai/gpt-5.6-sol' },
      },
      parts: [
        {
          id: 'prt_history_user',
          sessionID: root,
          messageID: 'msg_000000000000000000000001',
          type: 'text',
          text: 'Show my saved conversation.',
        },
      ],
    },
    {
      info: {
        id: 'msg_000000000000000000000002',
        sessionID: root,
        parentID: 'msg_000000000000000000000001',
        role: 'assistant',
        time: { created: created + 1, completed: created + 2 },
        agent: 'kortix',
        mode: 'build',
        providerID: 'kortix',
        modelID: 'openai/gpt-5.6-sol',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: 'stop',
      },
      parts: [
        {
          id: 'prt_history_reply',
          sessionID: root,
          messageID: 'msg_000000000000000000000002',
          type: 'text',
          text: 'This reply is stored in the database.',
        },
      ],
    },
  ];
}

export async function seedSessionTranscript(
  env: Env,
  input: {
    projectId: string;
    accountId: string;
    sessionId: string;
    ensureSandbox?: boolean;
    /**
     * The saved transcript to write, in place of the default prompt and reply.
     * A message is stored under its own `info.sessionID` when it names one, so
     * a sub-agent's messages land in their own OpenCode session, as a capture
     * stores them. `defaults` is the default prompt and reply.
     */
    messages?: (root: string, defaults: SavedMessage[]) => SavedMessage[];
    /** Store the history in the session log. `bearer`: the session owner's JWT or PAT, which mints the journal credential. */
    log?: { bearer: string };
  },
) {
  if (!env.databaseUrl || env.target === 'prod')
    throw new Error('A non-production database is required');
  const root = `ses_${input.sessionId.replaceAll('-', '')}`;
  const defaults = defaultSavedMessages(root, Date.now() - 60_000);
  const messages = input.messages?.(root, defaults) ?? defaults;
  const db = new Client({ connectionString: env.databaseUrl });
  // A dropped connection must fail the next query, not crash the runner.
  db.on('error', () => {});
  await db.connect();
  try {
    await db.query(
      "UPDATE kortix.project_sessions SET status = 'stopped', opencode_session_id = $2, sandbox_id = $1, sandbox_url = 'http://127.0.0.1:1' WHERE session_id = $1",
      [input.sessionId, root],
    );
    if (input.log) {
      await journalSessionLog(env, { ...input, bearer: input.log.bearer, root, messages });
    } else {
      await db.query(
        'INSERT INTO kortix.session_transcript_mirrors (session_id, project_id, account_id, opencode_session_id, head_complete) VALUES ($1,$2,$3,$4,true)',
        [input.sessionId, input.projectId, input.accountId, root],
      );
      for (const message of messages) {
        await db.query(
          'INSERT INTO kortix.session_transcript_messages (session_id, message_id, opencode_session_id, role, message_created_at, info, parts) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [
            input.sessionId,
            message.info.id,
            typeof message.info.sessionID === 'string' ? message.info.sessionID : root,
            message.info.role,
            new Date(message.info.time.created),
            JSON.stringify(message.info),
            JSON.stringify(message.parts),
          ],
        );
      }
    }
    if (input.ensureSandbox !== false) {
      await db.query(
        "INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id, base_url) VALUES ($1::uuid,$1,$2,$3,'stopped',$1,'http://127.0.0.1:1')",
        [input.sessionId, input.accountId, input.projectId],
      );
    }
  } finally {
    await db.end();
  }
  return { root, messages };
}

/**
 * Journals `messages` (the whole conversation, in order) into the session log of a session
 * {@link seedSessionTranscript} seeded with `log`, as the box's daemon does after a turn: every
 * message again at a newer rev, so a message that is new gets its seq and one that is stored
 * is replaced. Turns the project's `session_log` flag on.
 */
export async function journalSessionLog(
  env: Env,
  input: {
    projectId: string;
    accountId: string;
    sessionId: string;
    bearer: string;
    root: string;
    messages: SavedMessage[];
  },
) {
  const minted = await fetch(`${env.apiUrl}/accounts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Session log journal (test fixture)', account_id: input.accountId }),
  });
  if (minted.status !== 201) throw new Error(`POST /accounts/tokens answered ${minted.status}: ${await minted.text()}`);
  const credential = (await minted.json()) as { token_id: string; secret_key: string };
  const db = new Client({ connectionString: env.databaseUrl! });
  db.on('error', () => {});
  await db.connect();
  // The credential a box holds: bound to the project and the session, live while its sandbox row is active.
  await db.query('UPDATE kortix.account_tokens SET project_id = $2, session_id = $3 WHERE token_id = $1', [
    credential.token_id,
    input.projectId,
    input.sessionId,
  ]);
  // The session's sandbox row is active for the call: a stopped one is turned active and back,
  // and a session without one gets a temporary row.
  const held = await db.query<{ status: string }>(
    "UPDATE kortix.session_sandboxes s SET status = 'active' FROM kortix.session_sandboxes o WHERE s.session_id = $1 AND o.sandbox_id = s.sandbox_id RETURNING o.status",
    [input.sessionId],
  );
  if (!held.rows.length) {
    await db.query(
      "INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES (gen_random_uuid(), $1, $2, $3, 'active')",
      [input.sessionId, input.accountId, input.projectId],
    );
  }
  try {
    const rows = input.messages.map((m) => ({
      runtime_session_id: typeof m.info.sessionID === 'string' ? m.info.sessionID : input.root,
      info: m.info,
      parts: m.parts,
    })) as unknown as V1Row[];
    const { threads, ...session } = fromV1({ session_id: input.sessionId, root_id: input.root, rows }, { harness: 'opencode' });
    const producer = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1.0.0' };
    const rev = Date.now() * 1000;
    const puts = threads.flatMap((t) => t.messages).map((message, i) => ({ rev: rev + i, message: { ...message, producer } }));
    const body = { generation: 0, session, threads: threads.map(({ messages: _m, ...head }) => head), puts, tombstones: [] };
    const journal = await fetch(`${env.apiUrl}/projects/${input.projectId}/sessions/${input.sessionId}/log/journal`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.secret_key}`, 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify(body)),
    });
    const acked = journal.ok ? ((await journal.json()) as { acked: unknown[] }).acked.length : -1;
    if (acked !== puts.length) throw new Error(`POST …/log/journal answered ${journal.status}, acked ${acked} of ${puts.length}`);
    await db.query(
      `UPDATE kortix.projects SET metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object('experimental', COALESCE(metadata->'experimental', '{}'::jsonb) || '{"session_log":true}'::jsonb)
       WHERE project_id = $1`,
      [input.projectId],
    );
  } finally {
    // The credential lives for this call only.
    await fetch(`${env.apiUrl}/accounts/tokens/${credential.token_id}?account_id=${input.accountId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${input.bearer}` },
    }).catch(() => {});
    await (held.rows.length
      ? db.query('UPDATE kortix.session_sandboxes SET status = $2 WHERE session_id = $1', [input.sessionId, held.rows[0]!.status])
      : db.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1 AND external_id IS NULL', [input.sessionId])
    ).catch(() => {});
    await db.end();
  }
}
