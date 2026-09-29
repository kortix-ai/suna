import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  TRANSCRIPT_CAPTURE_MAX_CONCURRENT,
  TRANSCRIPT_CAPTURE_QUEUE_MAX,
  captureSessionTranscriptMirror,
} from '../projects/lib/session-transcript-capture';
import { readSessionTranscriptMirror } from '../projects/lib/session-transcript-mirror';
import {
  type SeededProject,
  localTestDatabaseUrl,
  removeSeeded,
  seedProject,
  seedSession,
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

test("a sub-agent's transcript is saved under its own OpenCode session, and a root read never shows it", async () => {
  const db = new Client({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-children-test', {
      metadata: { experimental: { session_transcript_history: true } },
    });
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_parent';
    const child = 'ses_subagent';
    await db.query(
      'UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1',
      [sessionId, root],
    );
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
    const capture = (
      rootPayload: unknown[],
      children: Array<{ payload: unknown[]; complete: boolean }>,
    ) =>
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
    const subagent = await readSessionTranscriptMirror({
      sessionId,
      limit: 40,
      opencodeSessionId: child,
    });
    expect(subagent?.messages.map((m) => m.info.id)).toEqual(['msg_101u', 'msg_102a']);
    expect(subagent?.opencode_session_id).toBe(child);
    expect(subagent?.root_opencode_session_id).toBe(root);
    expect(subagent?.head_complete).toBe(true);
    expect((subagent?.messages[1].parts[0].state as { input: unknown }).input).toEqual({
      command: 'ls',
    });

    // A rewind of the root deletes root rows only: the sub-agent was never in
    // the root read, so it is not "gone".
    await capture(rootRows.slice(0, 1), []);
    expect(await count(root)).toBe(1);
    expect(await count(child)).toBe(2);

    // A whole sub-agent read replaces its transcript.
    await capture(rootRows, [{ payload: childRows.slice(0, 1), complete: true }]);
    expect(await count(child)).toBe(1);

    // A partial one writes nothing: a saved sub-agent is whole or absent.
    await capture(rootRows, [{ payload: [], complete: false }]);
    expect(await count(child)).toBe(1);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

test('a complete read of an empty conversation is saved and served as complete and empty', async () => {
  const db = new Client({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-empty-test', {
      metadata: { experimental: { session_transcript_history: true } },
    });
    const sessionId = await seedSession(project, randomUUID());
    const root = 'ses_empty';
    await db.query(
      'UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1',
      [sessionId, root],
    );
    const capture = (headComplete: boolean) =>
      captureSessionTranscriptMirror(sessionId, {
        readMessages: async () => ({
          opencodeSessionId: root,
          payload: [],
          headComplete,
          complete: headComplete,
        }),
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
    expect(
      await readSessionTranscriptMirror({ sessionId, limit: 40, opencodeSessionId: 'ses_child' }),
    ).toBeNull();
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 20_000);

/**
 * The capture gate (KRTX-643): a capture holds one shared-pool connection for
 * its whole life, so unbounded concurrent captures pinned every DEFAULT_DB_POOL_MAX
 * slot per task and starved the request path (prod 2026-09-28). Background
 * captures must queue behind a small slot count; a tail capture (the awaited
 * stop-button read) must never queue behind them.
 *
 * Real PostgreSQL; the runtime read is injected.
 */
test('background captures queue behind the slot gate and a tail capture bypasses it', async () => {
  const db = new Client({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  let project: SeededProject | undefined;
  try {
    project = await seedProject('transcript-capture-gate-test', {
      metadata: { experimental: { session_transcript_history: true } },
    });
    const payload = (root: string) => ({
      opencodeSessionId: root,
      payload: [
        {
          info: {
            id: `msg_${root}`,
            sessionID: root,
            role: 'assistant',
            time: { created: 1, completed: 2 },
          },
          parts: [{ id: 'prt_1', type: 'text', text: 'Gated capture' }],
        },
      ],
      headComplete: true,
      complete: true,
    });
    const seededProject = project;
    const pinnedSession = async (root: string) => {
      const sessionId = await seedSession(seededProject, randomUUID());
      await db.query(
        'UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1',
        [sessionId, root],
      );
      return sessionId;
    };

    // 1) The cap: more captures than slots, never more than the cap inside the read.
    let inFlight = 0;
    let maxInFlight = 0;
    const gated = await Promise.all(
      [0, 1, 2, 3].map(async (index) => {
        const root = `ses_gate_${index}`;
        const sessionId = await pinnedSession(root);
        return captureSessionTranscriptMirror(sessionId, {
          readMessages: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 30));
            inFlight -= 1;
            return payload(root);
          },
        });
      }),
    );
    // Without the gate the four concurrent captures would all overlap (4 > 2).
    expect(maxInFlight).toBeLessThanOrEqual(TRANSCRIPT_CAPTURE_MAX_CONCURRENT);
    expect(gated.every((result) => result !== null)).toBe(true);

    // 2) The bypass: a tail capture starts while a background capture holds a slot.
    const rootA = 'ses_gate_bg';
    const sessionA = await pinnedSession(rootA);
    const rootB = 'ses_gate_tail';
    const sessionB = await pinnedSession(rootB);
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = captureSessionTranscriptMirror(sessionA, {
      readMessages: async () => {
        await slowGate;
        return payload(rootA);
      },
    });
    // Let the background capture take a slot before the tail capture starts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    let tailStarted = false;
    const tail = captureSessionTranscriptMirror(
      sessionB,
      {
        readMessages: async () => {
          tailStarted = true;
          return payload(rootB);
        },
      },
      { scope: 'tail' },
    );
    await Promise.race([tail, new Promise((resolve) => setTimeout(resolve, 500))]);
    expect(tailStarted).toBe(true);
    releaseSlow();
    expect((await tail)?.head_complete).toBe(true);
    await slow;

    // 3) Queue-full backpressure: past the slots plus the whole queue, the next
    //    capture skips (null) instead of queueing forever.
    const burstRoots = Array.from(
      { length: TRANSCRIPT_CAPTURE_MAX_CONCURRENT + TRANSCRIPT_CAPTURE_QUEUE_MAX + 1 },
      (_, index) => `ses_gate_q${index}`,
    );
    const burst = await Promise.all(
      burstRoots.map(async (root) =>
        captureSessionTranscriptMirror(await pinnedSession(root), {
          readMessages: async () => payload(root),
        }),
      ),
    );
    // At least the overflow capture skipped. Nothing ran outside the cap.
    expect(maxInFlight).toBeLessThanOrEqual(TRANSCRIPT_CAPTURE_MAX_CONCURRENT);
    expect(burst.some((result) => result === null)).toBe(true);
    expect(burst.every((result) => result === null || result.captured === 1)).toBe(true);
  } finally {
    if (project) await removeSeeded([project]);
    await db.end();
  }
}, 60_000);
