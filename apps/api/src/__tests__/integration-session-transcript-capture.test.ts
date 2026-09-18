import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { captureSessionTranscriptMirror } from '../projects/lib/session-transcript-capture';
import { createAuthUser, deleteAuthUser } from '../../../../tests/e2e/helpers/session-auth';
import {
  createDatabaseProject,
  createDatabaseSession,
  deleteDatabaseProject,
} from '../../../../tests/src/fixtures/database-project';
import { loadEnv } from '../../../../tests/src/core/env';

test('complete capture persists all pages, retries, serializes writes, and retains history when disabled', async () => {
  const env = loadEnv();
  if (!env.databaseUrl || env.target !== 'local')
    throw new Error('Run against the local test database');
  const user = await createAuthUser(`capture-${randomUUID()}@example.test`, {
    supabaseUrl: env.supabaseUrl,
    password: 'TranscriptCapture123!',
  });
  const db = new Client({ connectionString: env.databaseUrl });
  await db.connect();
  const accountId = randomUUID();
  let projectId = '';
  try {
    await db.query('INSERT INTO kortix.accounts (account_id, name) VALUES ($1,$2)', [
      accountId,
      'Transcript capture test',
    ]);
    const project = await createDatabaseProject(env, {
      accountId,
      userId: user.id,
      name: 'Transcript capture',
      metadata: { experimental: { session_transcript_history: true } },
    });
    projectId = project.id;
    const sessionId = await createDatabaseSession(env, { projectId, accountId, userId: user.id });
    const root = 'ses_capture';
    await db.query(
      'UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1',
      [sessionId, root],
    );
    const messages = (count: number, text = 'Saved reply') =>
      Array.from({ length: count }, (_, index) => ({
        info: {
          id: `msg_${String(index).padStart(12, '0')}`,
          sessionID: root,
          role: 'assistant',
          time: { created: index + 1, completed: index + 2 },
        },
        parts: [{ id: `prt_${index}`, type: 'text', text }],
      }));
    let attempts = 0;
    const result = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async (_id, options) => {
        expect(options?.fullHistory).toBe(true);
        if (++attempts < 3) throw new Error('transient runtime failure');
        return { opencodeSessionId: root, payload: messages(620), headComplete: true };
      },
    });
    expect(attempts).toBe(3);
    expect(result).toEqual({ captured: 620, head_complete: true, pruned: 0 });
    const count = async () =>
      Number(
        (
          await db.query(
            'SELECT count(*) FROM kortix.session_transcript_messages WHERE session_id = $1',
            [sessionId],
          )
        ).rows[0].count,
      );
    expect(await count()).toBe(620);
    const rerun = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => ({
        opencodeSessionId: root,
        payload: messages(620),
        headComplete: true,
      }),
    });
    expect(rerun?.captured).toBe(620);
    expect(await count()).toBe(620);
    const failed = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => {
        throw new Error('runtime offline');
      },
    });
    expect(failed).toBeNull();
    expect(await count()).toBe(620);

    let release = () => {};
    let secondRead = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => {
        await held;
        return { opencodeSessionId: root, payload: messages(621, 'First'), headComplete: true };
      },
    });
    const second = captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => {
        secondRead = true;
        return { opencodeSessionId: root, payload: messages(622, 'Second'), headComplete: true };
      },
    });
    await Promise.resolve();
    expect(secondRead).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(await count()).toBe(622);
    expect(
      (
        await db.query(
          'SELECT parts FROM kortix.session_transcript_messages WHERE session_id=$1 ORDER BY message_id DESC LIMIT 1',
          [sessionId],
        )
      ).rows[0].parts[0].text,
    ).toBe('Second');

    await db.query(
      "UPDATE kortix.projects SET metadata = jsonb_set(metadata, '{experimental,session_transcript_history}', 'false'::jsonb) WHERE project_id=$1",
      [projectId],
    );
    const disabled = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async (_id, options) => {
        expect(options?.fullHistory).toBe(false);
        return { opencodeSessionId: root, payload: messages(622).slice(-80), headComplete: false };
      },
    });
    expect(disabled?.pruned).toBe(0);
    expect(await count()).toBe(622);

    await db.query(
      "UPDATE kortix.projects SET metadata = jsonb_set(metadata, '{experimental,session_transcript_history}', 'true'::jsonb) WHERE project_id=$1",
      [projectId],
    );
    const stale = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => ({
        opencodeSessionId: 'ses_replaced',
        payload: [],
        headComplete: true,
      }),
    });
    expect(stale).toBeNull();
    expect(await count()).toBe(622);
    const empty = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => ({
        opencodeSessionId: root,
        payload: [],
        headComplete: true,
      }),
    });
    expect(empty).toEqual({ captured: 0, head_complete: true, pruned: 0 });
    expect(await count()).toBe(0);
  } finally {
    if (projectId) await deleteDatabaseProject(env, projectId);
    await db.query('DELETE FROM kortix.accounts WHERE account_id=$1', [accountId]);
    await db.end();
    await deleteAuthUser(user.id, { supabaseUrl: env.supabaseUrl });
  }
}, 20_000);
