import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PgClient } from './helpers/pg-client';
import { captureSessionTranscriptMirror } from '../projects/lib/session-transcript-capture';
import {
  mirrorHoldsStrippedRows,
  readSessionTranscriptMirror,
  setTranscriptRewindMarker,
} from '../projects/lib/session-transcript-mirror';
import {
  localTestDatabaseUrl,
  removeSeeded,
  seedProject,
  seedSession,
  type SeededProject,
} from './helpers/integration-fixtures';

test('complete capture persists all pages, retries, serializes writes, and keeps history whatever the project stored', async () => {
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-test');
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
    expect(result).toEqual({ captured: 620, head_complete: true });
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

    // Saved history graduated out of the flag system. A project that stored
    // the old `false` override still reads the whole history at turn end.
    await db.query(
      `UPDATE kortix.projects SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"experimental":{"session_transcript_history":false}}'::jsonb WHERE project_id=$1`,
      [projectId],
    );
    const overridden = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async (_id, options) => {
        expect(options?.fullHistory).toBe(true);
        return { opencodeSessionId: root, payload: messages(622).slice(-80), headComplete: false };
      },
    });
    expect(overridden?.captured).toBe(80);
    expect(await count()).toBe(622);
    // A Stop reads one page and deletes nothing: 80 rows read, 622 kept.
    const tail = await captureSessionTranscriptMirror(
      sessionId,
      {
        readMessages: async (_id, options) => {
          expect(options?.fullHistory).toBe(false);
          return { opencodeSessionId: root, payload: messages(622).slice(-80), headComplete: false };
        },
      },
      { scope: 'tail' },
    );
    expect(tail).toEqual({ captured: 80, head_complete: true });
    expect(await count()).toBe(622);

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
    // A complete read of nothing is no licence to delete: a box that lost its
    // state answers exactly this. Only a recorded rewind deletes.
    expect(empty).toEqual({ captured: 0, head_complete: true });
    expect(await count()).toBe(622);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test('a turn writes only what changed, and a shorter read deletes nothing', async () => {
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-delta-test');
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

    // A shorter complete read is what a box that lost its state answers. With
    // no recorded rewind it deletes nothing.
    await captureSessionTranscriptMirror(sessionId, read(messages(40)));
    expect(await count()).toBe(102);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test("a sub-agent's transcript is saved under its own OpenCode session, and a root read never shows it", async () => {
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-children-test');
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_parent';
    const child = 'ses_subagent';
    await db.query('UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1', [
      sessionId,
      root,
    ]);
    const message = (session: string, id: string, created: number, parts: unknown[]) => ({
      info: {
        id,
        sessionID: session,
        role: id.endsWith('u') ? 'user' : 'assistant',
        time: id.endsWith('u') ? { created } : { created, completed: created + 1 },
      },
      parts,
    });
    const rootRows = [
      message(root, 'msg_001u', 1, [{ id: 'p1', type: 'text', text: 'Explore the repository.' }]),
      message(root, 'msg_002a', 2, [
        {
          id: 'p2',
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            input: { description: 'Explore', prompt: 'List the files.' },
            output: 'Found two files.',
            metadata: { sessionId: child },
            time: { start: 2, end: 3 },
          },
        },
      ]),
    ];
    const childRows = [
      message(child, 'msg_101u', 2, [{ id: 'c1', type: 'text', text: 'List the files.' }]),
      message(child, 'msg_102a', 3, [
        {
          id: 'c2',
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'a.ts b.ts',
            metadata: {},
            time: { start: 3, end: 4 },
          },
        },
      ]),
    ];
    const capture = (rootPayload: unknown[], children: Array<{ payload: unknown[]; complete: boolean }>) =>
      captureSessionTranscriptMirror(sessionId, {
        readMessages: async () => ({
          opencodeSessionId: root,
          payload: rootPayload,
          headComplete: true,
          complete: true,
          children: children.map((entry) => ({ opencodeSessionId: child, ...entry })),
        }),
      });
    const count = async (opencodeSessionId: string) =>
      Number(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM kortix.session_transcript_messages WHERE session_id = $1 AND opencode_session_id = $2',
            [sessionId, opencodeSessionId],
          )
        ).rows[0].n,
      );

    await capture(rootRows, [{ payload: childRows, complete: true }]);
    expect(await count(root)).toBe(2);
    expect(await count(child)).toBe(2);

    // The conversation is the root's alone; the sub-agent is its own window.
    const conversation = await readSessionTranscriptMirror({ sessionId, limit: 40 });
    expect(conversation?.messages.map((m) => m.info.id)).toEqual(['msg_001u', 'msg_002a']);
    expect(conversation?.total).toBe(2);
    const subagent = await readSessionTranscriptMirror({ sessionId, limit: 40, opencodeSessionId: child });
    expect(subagent?.messages.map((m) => m.info.id)).toEqual(['msg_101u', 'msg_102a']);
    expect(subagent?.opencode_session_id).toBe(child);
    expect(subagent?.root_opencode_session_id).toBe(root);
    expect(subagent?.head_complete).toBe(true);
    expect((subagent?.messages[1].parts[0].state as { input: unknown }).input).toEqual({ command: 'ls' });

    // A shorter root read deletes nothing, and the sub-agent was never in it.
    await capture(rootRows.slice(0, 1), []);
    expect(await count(root)).toBe(2);
    expect(await count(child)).toBe(2);

    // A shorter whole sub-agent read merges: a sub-agent has no rewind.
    await capture(rootRows, [{ payload: childRows.slice(0, 1), complete: true }]);
    expect(await count(child)).toBe(2);

    // A partial one writes nothing: a saved sub-agent is whole or absent.
    await capture(rootRows, [{ payload: [], complete: false }]);
    expect(await count(child)).toBe(2);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test('a complete read of an empty conversation is saved and served as complete and empty', async () => {
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-empty-test');
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_empty';
    await db.query('UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1', [
      sessionId,
      root,
    ]);
    const capture = (headComplete: boolean) =>
      captureSessionTranscriptMirror(sessionId, {
        readMessages: async () => ({ opencodeSessionId: root, payload: [], headComplete, complete: headComplete }),
      });

    // Nothing captured, or a read that did not reach the head: unknown, never empty.
    expect(await readSessionTranscriptMirror({ sessionId, limit: 40 })).toBeNull();
    await capture(false);
    expect(await readSessionTranscriptMirror({ sessionId, limit: 40 })).toBeNull();

    // A complete read of the runtime that found no messages is the proof.
    await capture(true);
    expect(await readSessionTranscriptMirror({ sessionId, limit: 40 })).toMatchObject({
      opencode_session_id: root,
      root_opencode_session_id: root,
      total: 0,
      head_complete: true,
      next_cursor: null,
      messages: [],
    });
    // It speaks for the conversation only: a sub-agent with no rows is not saved.
    expect(await readSessionTranscriptMirror({ sessionId, limit: 40, opencodeSessionId: 'ses_child' })).toBeNull();
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test('a transcript string Postgres jsonb cannot represent is made storable, not a doomed capture (KRTX-1701)', async () => {
  /*
    A tool output that carries U+0000 (binary bytes through a shell) makes the
    mirror INSERT fail with `unsupported Unicode escape sequence — \u0000
    cannot be converted to text.` (SQLSTATE 22P05). The write is deterministic
    on its content, so every later capture of that session retried the same
    doomed transaction and warned — 568 lines in one prod hour, one session
    unmirrored from then on. The projection must make such a string storable.
  */
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-jsonb-unsafe');
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_jsonb_unsafe';
    await db.query('UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1', [
      sessionId,
      root,
    ]);
    const messages = [
      {
        info: {
          id: 'msg_bin',
          sessionID: root,
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
        parts: [
          {
            id: 'prt_bin',
            type: 'tool',
            state: { status: 'done', input: { command: 'xxd header.bin' }, output: 'GIF89a\u0000\u0001D\u0000;' },
          },
        ],
      },
      {
        info: {
          id: 'msg_text',
          sessionID: root,
          role: 'assistant',
          time: { created: 3, completed: 4 },
        },
        parts: [{ id: 'prt_text', type: 'text', text: 'clean reply' }],
      },
    ];
    const result = await captureSessionTranscriptMirror(sessionId, {
      readMessages: async () => ({
        opencodeSessionId: root,
        payload: messages,
        headComplete: true,
        complete: true,
      }),
    });
    expect(result).toEqual({ captured: 2, head_complete: true });

    const rows = await db.query(
      'SELECT message_id, parts FROM kortix.session_transcript_messages WHERE session_id = $1 ORDER BY message_id',
      [sessionId],
    );
    expect(rows.rowCount).toBe(2);
    // The stored text is jsonb-legal: no U+0000 survived, the bytes around it
    // and the clean message did.
    expect(JSON.stringify(rows.rows)).not.toContain('\\u0000');
    expect((rows.rows[0].parts as unknown[])[0]).toMatchObject({
      type: 'tool',
      state: { status: 'done', output: 'GIF89a\uFFFD\u0001D\uFFFD;' },
    });
    expect((rows.rows[1].parts as unknown[])[0]).toMatchObject({ type: 'text', text: 'clean reply' });
    // The head bit advanced — the session is mirrored again, and the next turn
    // ends an ordinary capture instead of the doomed one.
    const mirror = await db.query(
      'SELECT head_complete FROM kortix.session_transcript_mirrors WHERE session_id = $1',
      [sessionId],
    );
    expect(mirror.rows[0].head_complete).toBe(true);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test("a new runtime root keeps every row of the old root and saves its own next to them", async () => {
  // A box that lost its state pins a new root. That is the moment the saved
  // copy is the only copy of the old conversation, so a capture must never
  // delete it (Session Log Plan P0.1).
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-root-change-test');
    const sessionId = await seedSession(project, randomUUID());
    const oldRoot = 'ses_rootold';
    const newRoot = 'ses_rootnew';
    const pin = (root: string) =>
      db.query('UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1', [
        sessionId,
        root,
      ]);
    const message = (session: string, id: string, created: number, text: string) => ({
      info: {
        id,
        sessionID: session,
        role: id.endsWith('u') ? 'user' : 'assistant',
        time: id.endsWith('u') ? { created } : { created, completed: created + 1 },
      },
      parts: [{ id: `prt_${id}`, type: 'text', text }],
    });
    const oldRows = [
      message(oldRoot, 'msg_001u', 1_000, 'First question'),
      message(oldRoot, 'msg_002a', 2_000, 'First answer'),
      message(oldRoot, 'msg_003u', 3_000, 'Second question'),
      message(oldRoot, 'msg_004a', 4_000, 'Second answer'),
    ];
    const newRows = [
      message(newRoot, 'msg_101u', 10_000, 'Question on the new box'),
      message(newRoot, 'msg_102a', 11_000, 'Answer on the new box'),
    ];
    const capture = (root: string, payload: unknown[]) =>
      captureSessionTranscriptMirror(sessionId, {
        readMessages: async () => ({ opencodeSessionId: root, payload, headComplete: true, complete: true }),
      });
    const stored = async () =>
      (
        await db.query(
          `SELECT message_id, opencode_session_id, parts->0->>'text' AS text
             FROM kortix.session_transcript_messages
            WHERE session_id = $1
            ORDER BY message_created_at, message_id`,
          [sessionId],
        )
      ).rows;
    const oldStored = oldRows.map((row) => ({
      message_id: row.info.id,
      opencode_session_id: oldRoot,
      text: row.parts[0].text,
    }));
    const newStored = newRows.map((row) => ({
      message_id: row.info.id,
      opencode_session_id: newRoot,
      text: row.parts[0].text,
    }));

    await pin(oldRoot);
    expect(await capture(oldRoot, oldRows)).toEqual({ captured: 4, head_complete: true });
    expect(await stored()).toEqual(oldStored);

    // The box comes back with a different root and a complete read of it.
    await pin(newRoot);
    expect(await capture(newRoot, newRows)).toEqual({ captured: 2, head_complete: true });
    // Every old row survives unchanged; both roots sit in creation order.
    expect(await stored()).toEqual([...oldStored, ...newStored]);
    const mirror = await db.query(
      'SELECT opencode_session_id, head_complete FROM kortix.session_transcript_mirrors WHERE session_id = $1',
      [sessionId],
    );
    expect(mirror.rows[0]).toEqual({ opencode_session_id: newRoot, head_complete: true });

    // A window holds one root: the new root's runtime read can only settle
    // its own ids (the SDK's saved-copy root guard). The old root stays
    // readable as its own window.
    const conversation = await readSessionTranscriptMirror({ sessionId, limit: 40 });
    expect(conversation?.messages.map((m) => m.info.id)).toEqual(['msg_101u', 'msg_102a']);
    expect(conversation?.root_opencode_session_id).toBe(newRoot);
    const previous = await readSessionTranscriptMirror({ sessionId, limit: 40, opencodeSessionId: oldRoot });
    expect(previous?.messages.map((m) => m.info.id)).toEqual(['msg_001u', 'msg_002a', 'msg_003u', 'msg_004a']);
    expect(previous?.total).toBe(4);

    // A later turn on the new root still keeps the old root's rows.
    const nextRows = [...newRows, message(newRoot, 'msg_103u', 12_000, 'Follow-up')];
    expect(await capture(newRoot, nextRows)).toEqual({ captured: 3, head_complete: true });
    expect((await stored()).filter((row) => row.opencode_session_id === oldRoot)).toEqual(oldStored);

    // A tool part on the new root can name the old root, which makes the old
    // root look like a sub-agent. The new box does not know it, so a read of
    // it can come back complete and EMPTY. That is no proof the rows are gone.
    const subagent = 'ses_rootchild';
    const withChildren = (children: Array<{ opencodeSessionId: string; payload: unknown[] }>) =>
      captureSessionTranscriptMirror(sessionId, {
        readMessages: async () => ({
          opencodeSessionId: newRoot,
          payload: nextRows,
          headComplete: true,
          complete: true,
          children: children.map((child) => ({ ...child, complete: true })),
        }),
      });
    const childRows = [
      message(subagent, 'msg_201u', 10_500, 'Sub-agent task'),
      message(subagent, 'msg_202a', 10_600, 'Sub-agent result'),
    ];
    await withChildren([
      { opencodeSessionId: oldRoot, payload: [] },
      { opencodeSessionId: subagent, payload: childRows },
    ]);
    expect((await stored()).filter((row) => row.opencode_session_id === oldRoot)).toEqual(oldStored);
    const ofSubagent = async () =>
      (await stored()).filter((row) => row.opencode_session_id === subagent).map((row) => row.message_id);
    expect(await ofSubagent()).toEqual(['msg_201u', 'msg_202a']);
    // A shorter complete read of a sub-agent merges too: no rewind, no delete.
    await withChildren([{ opencodeSessionId: subagent, payload: childRows.slice(0, 1) }]);
    expect(await ofSubagent()).toEqual(['msg_201u', 'msg_202a']);

    // Legacy stripped rows under the old root do not mark the current root
    // as stripped, so the wake backfill does not re-read the box for them.
    await db.query(
      `UPDATE kortix.session_transcript_messages
          SET parts = '[{"id":"prt_stripped","type":"tool","tool":"bash","state":{"status":"completed","output":"done"}}]'::jsonb
        WHERE session_id = $1 AND message_id = 'msg_002a'`,
      [sessionId],
    );
    expect(await mirrorHoldsStrippedRows(sessionId, oldRoot)).toBe(true);
    expect(await mirrorHoldsStrippedRows(sessionId, newRoot)).toBe(false);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test('only a recorded rewind deletes, and only the rewound rows', async () => {
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-rewind-test');
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_rewind';
    await db.query('UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1', [
      sessionId,
      root,
    ]);
    // Ten messages, ids deliberately NOT in time order (OpenCode 1.18.15+
    // does not promise it): the stored order is (created, id).
    const message = (n: number) => ({
      info: {
        id: `msg_${String((n * 7) % 10)}${String(n).padStart(2, '0')}`,
        sessionID: root,
        role: n % 2 === 0 ? 'user' : 'assistant',
        time: n % 2 === 0 ? { created: 1_000 + n } : { created: 1_000 + n, completed: 1_001 + n },
      },
      parts: [{ id: `prt_${n}`, type: 'text', text: `message ${n}` }],
    });
    const all = Array.from({ length: 10 }, (_, n) => message(n));
    const id = (n: number) => String(message(n).info.id);
    const ids = (ns: number[]) => ns.map(id);
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);
    const capture = (payload: unknown[], how: { complete?: boolean; caughtUp?: boolean } = { complete: true }) =>
      captureSessionTranscriptMirror(sessionId, {
        readMessages: async () => ({
          opencodeSessionId: root,
          payload,
          headComplete: how.complete === true,
          complete: how.complete === true,
          caughtUp: how.caughtUp === true,
        }),
      });
    const stored = async () =>
      (
        await db.query(
          'SELECT message_id FROM kortix.session_transcript_messages WHERE session_id = $1 ORDER BY message_created_at, message_id',
          [sessionId],
        )
      ).rows.map((row) => row.message_id as string);
    const marker = async () =>
      (
        await db.query('SELECT rewind_message_id FROM kortix.session_transcript_mirrors WHERE session_id = $1', [
          sessionId,
        ])
      ).rows[0]?.rewind_message_id ?? null;

    await capture(all);
    expect(await stored()).toEqual(ids(range(0, 10)));

    // No rewind recorded: a shorter complete read, a shorter caught-up read
    // and an empty complete read all delete nothing.
    await capture(all.slice(0, 6));
    await capture(all.slice(4, 7), { caughtUp: true });
    await capture([]);
    expect(await stored()).toEqual(ids(range(0, 10)));

    // A rewind at message 6 is STAGED: the box still lists every message, so
    // nothing goes and the marker waits.
    await setTranscriptRewindMarker(sessionId, root, id(6));
    expect(await marker()).toBe(id(6));
    await capture(all);
    expect(await stored()).toEqual(ids(range(0, 10)));
    expect(await marker()).toBe(id(6));

    // A caught-up read that stops ABOVE the rewind point cannot see the whole
    // rewound range: it deletes nothing and leaves the marker.
    const replacement = [message(10), message(11)];
    await capture([message(7), ...replacement], { caughtUp: true });
    expect(await stored()).toEqual(ids(range(0, 12)));
    expect(await marker()).toBe(id(6));

    // The next prompt commits it: the read lacks 6..9 and adds the
    // replacement turn. Exactly 6..9 go; 0..5 stay; the marker is spent.
    await capture([...all.slice(0, 6), ...replacement]);
    expect(await stored()).toEqual(ids([0, 1, 2, 3, 4, 5, 10, 11]));
    expect(await marker()).toBeNull();
    // Spent: the same shorter read again deletes nothing.
    await capture(all.slice(0, 2));
    expect(await stored()).toEqual(ids([0, 1, 2, 3, 4, 5, 10, 11]));

    // A caught-up read whose oldest row is at or below the rewind point
    // covers the whole range, and deletes it too.
    await setTranscriptRewindMarker(sessionId, root, id(10));
    await capture([message(4), message(5), message(12)], { caughtUp: true });
    expect(await stored()).toEqual(ids([0, 1, 2, 3, 4, 5, 12]));
    expect(await marker()).toBeNull();

    // `unrevert` clears the marker: a later shorter read deletes nothing.
    await setTranscriptRewindMarker(sessionId, root, id(2));
    await setTranscriptRewindMarker(sessionId, root, null);
    await capture(all.slice(0, 2));
    expect(await stored()).toEqual(ids([0, 1, 2, 3, 4, 5, 12]));

    // A marker for another root changes nothing.
    await setTranscriptRewindMarker(sessionId, 'ses_other', id(2));
    expect(await marker()).toBeNull();
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test('a pi session never loses rows on any read', async () => {
  // pi has no rewind: the daemon answers `POST /session/:id/revert` with 501,
  // so the proxy never records a marker, and no read of a pi box deletes.
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-pi-test');
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_pirootsession';
    await db.query('UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1', [
      sessionId,
      root,
    ]);
    const rows = Array.from({ length: 6 }, (_, n) => ({
      info: {
        id: `msg_pi${n}`,
        sessionID: root,
        role: n % 2 === 0 ? 'user' : 'assistant',
        time: n % 2 === 0 ? { created: 100 + n } : { created: 100 + n, completed: 101 + n },
      },
      parts: [{ id: `prt_pi${n}`, type: 'text', text: `pi message ${n}` }],
    }));
    const capture = (payload: unknown[], how: { complete: boolean; caughtUp?: boolean }, scope?: 'tail') =>
      captureSessionTranscriptMirror(
        sessionId,
        {
          readMessages: async () => ({
            opencodeSessionId: root,
            payload,
            headComplete: how.complete,
            complete: how.complete,
            caughtUp: how.caughtUp === true,
          }),
        },
        scope ? { scope } : undefined,
      );
    const count = async () =>
      Number(
        (
          await db.query('SELECT count(*)::int AS n FROM kortix.session_transcript_messages WHERE session_id = $1', [
            sessionId,
          ])
        ).rows[0].n,
      );

    await capture(rows, { complete: true });
    expect(await count()).toBe(6);
    await capture(rows.slice(0, 2), { complete: true });
    await capture(rows.slice(3, 4), { complete: false, caughtUp: true });
    await capture(rows.slice(5), { complete: false });
    await capture(rows.slice(5), { complete: false }, 'tail');
    await capture([], { complete: true });
    expect(await count()).toBe(6);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);
