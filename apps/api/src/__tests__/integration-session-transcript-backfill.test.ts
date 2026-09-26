/**
 * Backfill on wake: what makes saved history work for sessions that already
 * exist. Capture otherwise runs only at turn end, so a project that enables the
 * flag got nothing for its existing sessions until each one was prompted again.
 *
 * Real PostgreSQL; the runtime read is injected.
 */
import { beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  backfillSessionTranscriptMirrorOnWake,
  resetTranscriptBackfillMemoForTests,
} from '../projects/lib/session-transcript-capture';
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
  const db = new Client({ connectionString: localTestDatabaseUrl() });
  await db.connect();
  const userId = randomUUID();
  const seeded: SeededProject[] = [];
  let accountId = '';
  try {
    accountId = await seedAccount('transcript-backfill-test');

    /** A session on a project with the flag as given, pinned to ROOT. */
    const seedSession = async (flagEnabled: boolean) => {
      const project = await seedProject(
        `backfill-${flagEnabled ? 'on' : 'off'}-${randomUUID().slice(0, 8)}`,
        {
          accountId,
          metadata: flagEnabled ? { experimental: { session_transcript_history: true } } : {},
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

    // 4. FLAG OFF ⇒ THE SURFACE STAYS DARK. No read, no rows. Turn-end capture
    //    keeps its legacy tail behaviour untouched.
    const off = await seedSession(false);
    await backfillSessionTranscriptMirrorOnWake(off, deps);
    expect(reads.has(off)).toBe(false);
    expect(await stored(off)).toBe(0);

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
