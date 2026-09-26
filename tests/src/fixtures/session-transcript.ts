import { Client } from 'pg';
import type { Env } from '../core/env';

export async function seedSessionTranscript(
  env: Env,
  input: {
    projectId: string;
    accountId: string;
    sessionId: string;
    ensureSandbox?: boolean;
    /** The saved transcript to write, in place of the default prompt and reply. */
    messages?: (root: string) => Array<{
      info: { id: string; role: string; time: { created: number; completed?: number } } & Record<
        string,
        unknown
      >;
      parts: Array<Record<string, unknown>>;
    }>;
  },
) {
  if (!env.databaseUrl || env.target === 'prod')
    throw new Error('A non-production database is required');
  const root = `ses_${input.sessionId.replaceAll('-', '')}`;
  const created = Date.now() - 60_000;
  const messages = input.messages?.(root) ?? [
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
  const db = new Client({ connectionString: env.databaseUrl });
  await db.connect();
  try {
    await db.query(
      "UPDATE kortix.project_sessions SET status = 'stopped', opencode_session_id = $2, sandbox_id = $1, sandbox_url = 'http://127.0.0.1:1' WHERE session_id = $1",
      [input.sessionId, root],
    );
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
          root,
          message.info.role,
          new Date(message.info.time.created),
          JSON.stringify(message.info),
          JSON.stringify(message.parts),
        ],
      );
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
