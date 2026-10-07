/**
 * Backfill on wake: what makes saved history work for sessions that already
 * exist. Capture otherwise runs only at turn end, so a session nobody prompted
 * since saved history shipped had nothing saved until it was prompted again.
 *
 * Real PostgreSQL; the runtime read is injected.
 */
import { beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PgClient } from './helpers/pg-client';
import {
  backfillSessionTranscriptMirrorOnWake,
  resetTranscriptBackfillMemoForTests,
} from '../projects/lib/session-transcript-capture';
import { readSessionTranscriptMirror } from '../projects/lib/session-transcript-mirror';
import {
  localTestDatabaseUrl,
  removeSeeded,
  seedAccount,
  seedProject,
  seedSession as seedSessionRow,
  type SeededProject,
} from './helpers/integration-fixtures';

beforeEach(() => resetTranscriptBackfillMemoForTests());

const ROOT = 'ses_backfill';
const messages = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    info: {
      id: `msg_${String(index).padStart(12, '0')}`,
      sessionID: ROOT,
      role: 'assistant',
      time: { created: index + 1, completed: index + 2 },
    },
    parts: [{ id: `prt_${index}`, type: 'text', text: 'Saved before the flag existed' }],
  }));

test('a wake backfills an unmirrored session, repairs a headless one, and skips the rest', async () => {
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  const userId = randomUUID();
  const seeded: SeededProject[] = [];
  let accountId = '';
  try {
    accountId = await seedAccount('transcript-backfill-test');

    /** A session on a project with the flag as given (`default`: never set),
     *  pinned to ROOT. */
    const seedSession = async (flag: boolean | 'default') => {
      const project = await seedProject(
        `backfill-${flag === 'default' ? 'default' : flag ? 'on' : 'off'}-${randomUUID().slice(0, 8)}`,
        {
          accountId,
          metadata:
            flag === 'default' ? {} : { experimental: { session_transcript_history: flag } },
        },
      );
      seeded.push(project);
      const sessionId = await seedSessionRow(project, userId);
      await db.query(
        'UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1',
        [sessionId, ROOT],
      );
      return sessionId;
    };
    const stored = async (sessionId: string) =>
      Number(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM kortix.session_transcript_messages WHERE session_id = $1',
            [sessionId],
          )
        ).rows[0].n,
      );
    const reads = new Map<string, number>();
    // The box answers for whatever root the session is pinned to RIGHT NOW.
    // Returning a stale root instead would make the writer refuse the read as
    // a root mismatch, and the retry that follows would be what the counts
    // measured — not the guard under test.
    let activeRoot = ROOT;
    const deps = {
      readMessages: async (sessionId: string) => {
        reads.set(sessionId, (reads.get(sessionId) ?? 0) + 1);
        return {
          opencodeSessionId: activeRoot,
          payload: messages(120),
          headComplete: true,
          complete: true,
        };
      },
    };

    // 1. THE POINT OF THE FEATURE: an existing session nobody has prompted
    //    since the flag went on. Opening it must mirror what is already there.
    const fresh = await seedSession(true);
    expect(await stored(fresh)).toBe(0);
    await backfillSessionTranscriptMirrorOnWake(fresh, deps);
    expect(await stored(fresh)).toBe(120);
    const [mirror] = (
      await db.query(
        'SELECT head_complete, opencode_session_id FROM kortix.session_transcript_mirrors WHERE session_id = $1',
        [fresh],
      )
    ).rows;
    expect(mirror.head_complete).toBe(true);
    expect(mirror.opencode_session_id).toBe(ROOT);

    // 2. ONE ATTEMPT PER SESSION. `/start` answers `ready` on every poll; the
    //    backfill must not re-read the box once per poll for the session's life.
    await backfillSessionTranscriptMirrorOnWake(fresh, deps);
    expect(reads.get(fresh)).toBe(1);

    // 3. A HEADLESS MIRROR IS REPAIRED. Legacy retention pruned to 500 and
    //    cleared `head_complete`; that history is reachable again on wake.
    const pruned = await seedSession(true);
    await db.query(
      'INSERT INTO kortix.session_transcript_mirrors (session_id, project_id, account_id, opencode_session_id, head_complete) SELECT $1, project_id, account_id, $2, false FROM kortix.project_sessions WHERE session_id = $1',
      [pruned, ROOT],
    );
    await backfillSessionTranscriptMirrorOnWake(pruned, deps);
    expect(await stored(pruned)).toBe(120);

    // 4. A STORED OFF OVERRIDE IS INERT. Saved history graduated out of the
    //    flag system; a project that turned it off before keeps its history.
    const off = await seedSession(false);
    await backfillSessionTranscriptMirrorOnWake(off, deps);
    expect(reads.get(off)).toBe(1);
    expect(await stored(off)).toBe(120);

    // 4b. A project that never set the flag keeps its history.
    const unset = await seedSession('default');
    await backfillSessionTranscriptMirrorOnWake(unset, deps);
    expect(reads.get(unset)).toBe(1);
    expect(await stored(unset)).toBe(120);

    // 5. AN ALREADY-WHOLE MIRROR IS LEFT ALONE — no box read on every wake
    //    forever after.
    resetTranscriptBackfillMemoForTests();
    await backfillSessionTranscriptMirrorOnWake(fresh, deps);
    expect(reads.get(fresh)).toBe(1);

    // 6. AN ATTEMPT THAT COULD NOT RUN IS NOT A RESULT. `/start` reports
    //    `ready` before the OpenCode root is pinned, and the box can be briefly
    //    unreachable right after it comes up; capture answers null for both.
    //    Recording that as done would leave the session blank until some later
    //    turn end — the exact failure this whole function removes.
    const flaky = await seedSession(true);
    let boxUp = false;
    const flakyDeps = {
      readMessages: async (sessionId: string) => {
        reads.set(sessionId, (reads.get(sessionId) ?? 0) + 1);
        if (!boxUp) return null;
        return {
          opencodeSessionId: ROOT,
          payload: messages(120),
          headComplete: true,
          complete: true,
        };
      },
    };
    // A full-history capture retries internally, so one backfill round is
    // several reads. What matters is whether a LATER round happens at all.
    await backfillSessionTranscriptMirrorOnWake(flaky, flakyDeps);
    const afterFirst = reads.get(flaky) ?? 0;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await stored(flaky)).toBe(0);
    // The next open tries again rather than giving up for the process's life.
    await backfillSessionTranscriptMirrorOnWake(flaky, flakyDeps);
    expect(reads.get(flaky)!).toBeGreaterThan(afterFirst);
    boxUp = true;
    await backfillSessionTranscriptMirrorOnWake(flaky, flakyDeps);
    expect(await stored(flaky)).toBe(120);
    // Settled now: a result was recorded, so further opens read nothing.
    const afterSuccess = reads.get(flaky) ?? 0;
    await backfillSessionTranscriptMirrorOnWake(flaky, flakyDeps);
    expect(reads.get(flaky)).toBe(afterSuccess);
    // ...but it does not retry FOREVER: a session that can never be read must
    // not re-read its box once per open indefinitely.
    const unreadable = await seedSession(true);
    const deadDeps = {
      readMessages: async (sessionId: string) => {
        reads.set(sessionId, (reads.get(sessionId) ?? 0) + 1);
        return null;
      },
    };
    for (let i = 0; i < 3; i++) await backfillSessionTranscriptMirrorOnWake(unreadable, deadDeps);
    const atCap = reads.get(unreadable) ?? 0;
    expect(atCap).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await backfillSessionTranscriptMirrorOnWake(unreadable, deadDeps);
    expect(reads.get(unreadable)).toBe(atCap);

    // 7. A RE-PINNED ROOT IS NOT WHOLE. `head_complete` describes the root it
    //    was captured from; against a different one it proves nothing.
    resetTranscriptBackfillMemoForTests();
    activeRoot = 'ses_repinned';
    await db.query(
      'UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1',
      [fresh, activeRoot],
    );
    await backfillSessionTranscriptMirrorOnWake(fresh, deps);
    expect(reads.get(fresh)).toBe(2);
    const [repinned] = (
      await db.query(
        'SELECT head_complete, opencode_session_id FROM kortix.session_transcript_mirrors WHERE session_id = $1',
        [fresh],
      )
    ).rows;
    expect(repinned.opencode_session_id).toBe('ses_repinned');
    expect(repinned.head_complete).toBe(true);
    // The old root's rows are unreachable by id and must not linger beside the
    // new ones — 120, not 240.
    expect(await stored(fresh)).toBe(120);
  } finally {
    await removeSeeded(seeded).catch(() => {});
    if (accountId) {
      await db.query('DELETE FROM kortix.accounts WHERE account_id = $1', [accountId]).catch(() => {});
    }
    await db.end();
  }
});

test('a history the old mirror stripped is served with what it kept, read again on wake, and a 1:1 one left alone', async () => {
  const db = new PgClient({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  const seeded: SeededProject[] = [];
  let accountId = '';
  try {
    accountId = await seedAccount('transcript-backfill-stripped-test');
    const project = await seedProject(`backfill-stripped-${randomUUID().slice(0, 8)}`, {
      accountId,
    });
    seeded.push(project);
    const sessionId = await seedSessionRow(project, randomUUID());
    await db.query('UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1', [
      sessionId,
      ROOT,
    ]);
    // OpenCode titles a command with the command, and keeps its output in
    // `metadata.output`. The old mirror kept both.
    const call = (state: Record<string, unknown>) => ({
      id: 'prt_call',
      type: 'tool',
      tool: 'bash',
      callID: 'call_1',
      state: {
        status: 'completed',
        title: 'ls dist',
        metadata: { output: 'app.js', exit: 0 },
        time: { start: 1, end: 2 },
        ...state,
      },
    });
    const info = {
      id: 'msg_000000000001',
      sessionID: ROOT,
      role: 'assistant',
      time: { created: 1, completed: 2 },
    };
    // What the old mirror wrote: whole (`head_complete`), same root, and the
    // tool call without its input or output.
    await db.query(
      `INSERT INTO kortix.session_transcript_mirrors (session_id, project_id, account_id, opencode_session_id, head_complete)
       SELECT $1, project_id, account_id, $2, true FROM kortix.project_sessions WHERE session_id = $1`,
      [sessionId, ROOT],
    );
    await db.query(
      `INSERT INTO kortix.session_transcript_messages
         (session_id, message_id, opencode_session_id, role, message_created_at, message_completed_at, info, parts)
       VALUES ($1, $2, $3, 'assistant', to_timestamp(0.001), to_timestamp(0.002), $4::jsonb, $5::jsonb)`,
      [sessionId, info.id, ROOT, JSON.stringify(info), JSON.stringify([call({})])],
    );

    let reads = 0;
    const deps = {
      readMessages: async () => {
        reads += 1;
        return {
          opencodeSessionId: ROOT,
          payload: [{ info, parts: [call({ input: { command: 'ls dist' }, output: 'app.js' })] }],
          headComplete: true,
          complete: true,
        };
      },
    };
    const storedState = async () =>
      (
        await db.query(
          'SELECT parts FROM kortix.session_transcript_messages WHERE session_id = $1 AND message_id = $2',
          [sessionId, info.id],
        )
      ).rows[0].parts[0].state;

    // Served with what it kept, stored as it was: every client draws the
    // command and its output while the computer sleeps, and the wake below
    // still finds the row stripped.
    const served = await readSessionTranscriptMirror({ sessionId, limit: 40 });
    expect(served?.messages[0].parts[0].state).toMatchObject({ input: { command: 'ls dist' }, output: 'app.js' });
    expect('input' in (await storedState())).toBe(false);

    await backfillSessionTranscriptMirrorOnWake(sessionId, deps);
    expect(reads).toBe(1);
    expect(await storedState()).toMatchObject({ input: { command: 'ls dist' }, output: 'app.js' });

    // 1:1 now: the next wake has nothing to add and reads nothing.
    resetTranscriptBackfillMemoForTests();
    await backfillSessionTranscriptMirrorOnWake(sessionId, deps);
    expect(reads).toBe(1);
  } finally {
    await removeSeeded(seeded).catch(() => {});
    if (accountId) {
      await db.query('DELETE FROM kortix.accounts WHERE account_id = $1', [accountId]).catch(() => {});
    }
    await db.end();
  }
});
