import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { captureSessionTranscriptMirror } from '../projects/lib/session-transcript-capture';
import {
  localTestDatabaseUrl,
  removeSeeded,
  seedProject,
  seedSession,
  type SeededProject,
} from './helpers/integration-fixtures';

test('complete capture persists all pages, retries, serializes writes, and retains history when disabled', async () => {
  const db = new Client({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-test', {
      metadata: { experimental: { session_transcript_history: true } },
    });
    const projectId = project.project_id;
    const sessionId = await seedSession(project, randomUUID());
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
    // `complete: true` is a walk that read every page. Only such a read may
    // raise `head_complete` or delete a vanished id (7f81e09242).
    let attempts = 0;
    const result = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async (_id, options) => {
        expect(options?.fullHistory).toBe(true);
        if (++attempts < 3) throw new Error('transient runtime failure');
        return {
          opencodeSessionId: root,
          payload: messages(620),
          headComplete: true,
          complete: true,
        };
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
        complete: true,
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

    // Two captures of one session serialize: the first holds its read open,
    // and the second still writes last (622 rows, the newest one `Second`).
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => {
        await held;
        return {
          opencodeSessionId: root,
          payload: messages(621, 'First'),
          headComplete: true,
          complete: true,
        };
      },
    });
    const second = captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => {
        return {
          opencodeSessionId: root,
          payload: messages(622, 'Second'),
          headComplete: true,
          complete: true,
        };
      },
    });
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
        complete: true,
      }),
    });
    expect(stale).toBeNull();
    expect(await count()).toBe(622);
    const empty = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => ({
        opencodeSessionId: root,
        payload: [],
        headComplete: true,
        complete: true,
      }),
    });
    expect(empty).toEqual({ captured: 0, head_complete: true, pruned: 0 });
    expect(await count()).toBe(0);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test('a turn writes only what changed, and only what vanished is deleted', async () => {
  const db = new Client({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-delta-test', {
      metadata: { experimental: { session_transcript_history: true } },
    });
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_delta';
    await db.query(
      'UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1',
      [sessionId, root],
    );
    const messages = (count: number, edit?: { index: number; text: string }) =>
      Array.from({ length: count }, (_, index) => ({
        info: {
          id: `msg_${String(index).padStart(12, '0')}`,
          sessionID: root,
          role: 'assistant',
          time: { created: index + 1, completed: index + 2 },
        },
        parts: [
          {
            id: `prt_${index}`,
            type: 'text',
            text: edit && edit.index === index ? edit.text : 'Saved reply',
          },
        ],
      }));
    const read = (payload: unknown[]) => ({
      readMessages: async () => ({
        opencodeSessionId: root,
        payload,
        headComplete: true,
        complete: true,
      }),
    });
    const capturedAts = async (): Promise<Map<string, string>> =>
      new Map(
        (
          await db.query(
            // `::text`, not the driver's Date: `String(Date)` has SECOND
            // precision, both captures land inside the same second, and the
            // comparison then reports every row as untouched — including the
            // one that changed.
            'SELECT message_id, captured_at::text AS captured_at FROM kortix.session_transcript_messages WHERE session_id = $1',
            [sessionId],
          )
        ).rows.map((row) => [row.message_id as string, String(row.captured_at)]),
      );
    const count = async () =>
      Number(
        (
          await db.query(
            'SELECT count(*) FROM kortix.session_transcript_messages WHERE session_id = $1',
            [sessionId],
          )
        ).rows[0].count,
      );

    await captureSessionTranscriptMirror(sessionId, read(messages(100)));
    expect(await count()).toBe(100);
    const first = await capturedAts();

    // THE POINT OF THIS TEST. Every turn re-reads the whole history, and this
    // capture adds two messages and edits one. The other 99 rows must not be
    // rewritten: `captured_at` moves on every write, so an unchanged
    // `captured_at` is proof the row was left alone.
    await captureSessionTranscriptMirror(
      sessionId,
      read(messages(102, { index: 50, text: 'Edited reply' })),
    );
    expect(await count()).toBe(102);
    const second = await capturedAts();
    const rewritten = [...first.keys()].filter((id) => second.get(id) !== first.get(id));
    expect(rewritten).toEqual(['msg_000000000050']);
    expect(
      (
        await db.query(
          'SELECT parts FROM kortix.session_transcript_messages WHERE session_id=$1 AND message_id=$2',
          [sessionId, 'msg_000000000050'],
        )
      ).rows[0].parts[0].text,
    ).toBe('Edited reply');

    // A rewind removes messages upstream. A complete read IS the truth, so
    // exactly the ids it no longer contains are deleted — and nothing else.
    await captureSessionTranscriptMirror(sessionId, read(messages(40)));
    expect(await count()).toBe(40);
    const survivors = (
      await db.query(
        'SELECT message_id FROM kortix.session_transcript_messages WHERE session_id=$1 ORDER BY message_created_at, message_id',
        [sessionId],
      )
    ).rows.map((row) => row.message_id as string);
    expect(survivors[0]).toBe('msg_000000000000');
    expect(survivors.at(-1)).toBe('msg_000000000039');
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);
