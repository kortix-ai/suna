/**
 * Integration test (real PostgreSQL, fresh migrated database): the backfill of
 * old sessions (P3.1). A session whose history is only in the v1 mirror
 * (`session_transcript_*`) gets the v2 log the P2.7 capture would write
 * (`writeSessionLogFromMirror`, `session-log-capture.ts`): the backfill is a
 * cursor over those sessions, not a second converter.
 *
 * Every session here is synthetic. The mirror rows are inserted directly, as an
 * old session left them (no `session_logs` row, mostly no runtime projection).
 * The Storage bucket is `helpers/fake-session-storage.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromV1, SessionLogSchema, toV1, type SessionLog, type V1Row } from '@kortix/api-contract/session-log';
import { ZodError } from 'zod';
import {
  projectSessions,
  projects,
  sessionLogMessages,
  sessionLogs,
  sessionLogThreads,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { asc, eq, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { syntheticOpencodeSession } from './helpers/synthetic-opencode-session';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

const { backfillSessionLogs, roundTripMismatches, newBackfillState, BACKFILL_BATCH_SIZE } = await import('../projects/session-log-backfill');
const { writeSessionLogFromMirror } = await import('../projects/session-log-capture');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');
const { claimSessionLog } = await import('../projects/session-log-restore');
const { config } = await import('../config');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_backfillroot00000000001';
const CHILD = 'ses_backfillchild0000000001';
const T0 = Date.parse('2025-01-01T00:00:00.000Z');

let project: SeededProject;

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>>; runtime_session_id?: string | null };

/** A small root history: user/assistant pairs, `msg_<n>` created at n seconds. */
const plain = (n: number, text = `reply ${n}`, sid = ROOT): Msg => {
  const id = `msg_${String(n).padStart(6, '0')}`;
  const created = 1_790_000_000_000 + n * 1000;
  const info: Record<string, unknown> =
    n % 2 === 0
      ? { id, sessionID: sid, role: 'user', time: { created }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } }
      : { id, sessionID: sid, role: 'assistant', parentID: `msg_${String(n - 1).padStart(6, '0')}`, time: { created, completed: created + 500 }, providerID: 'kortix', modelID: 'm', finish: 'stop' };
  return { info, parts: [{ id: `prt_${n}`, sessionID: sid, messageID: id, type: 'text', text }] };
};

/** An old session: a mirror and its rows, no session log. `createdAt` orders the backfill. */
async function oldSession(messages: Msg[], opts: { createdAt?: Date; root?: string | null } = {}): Promise<string> {
  const sessionId = await seedSession(project, OWNER);
  if (opts.createdAt) await db.update(projectSessions).set({ createdAt: opts.createdAt }).where(eq(projectSessions.sessionId, sessionId));
  const runtimeSessionId = opts.root === undefined ? ROOT : opts.root;
  await db.insert(sessionTranscriptMirrors).values({ sessionId, projectId: project.project_id, accountId: project.account_id, runtimeSessionId });
  if (messages.length === 0) return sessionId;
  await db.insert(sessionTranscriptMessages).values(
    messages.map((m) => ({
      sessionId,
      messageId: String(m.info.id),
      runtimeSessionId: m.runtime_session_id === undefined ? String(m.info.sessionID) : m.runtime_session_id,
      role: String(m.info.role),
      info: m.info,
      parts: m.parts,
      messageCreatedAt: typeof (m.info.time as { created?: unknown } | undefined)?.created === 'number' ? new Date((m.info.time as { created: number }).created) : null,
    })),
  );
  return sessionId;
}

const synthetic = () => {
  const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns: 6 });
  return [...root, ...child];
};

/** `fromV1` of the stored mirror rows, as the capture reads them. */
async function fromMirror(sessionId: string): Promise<SessionLog> {
  const rows = await db
    .select({ runtime_session_id: sessionTranscriptMessages.runtimeSessionId, info: sessionTranscriptMessages.info, parts: sessionTranscriptMessages.parts })
    .from(sessionTranscriptMessages)
    .where(eq(sessionTranscriptMessages.sessionId, sessionId));
  return fromV1({ session_id: sessionId, root_id: ROOT, rows: rows as unknown as V1Row[] });
}

/** Everything the log stores for a session, without row times. */
async function snapshot(sessionId: string) {
  const [log] = await db
    .select({ generation: sessionLogs.generation, harness: sessionLogs.harnessCurrent, grade: sessionLogs.restoreGrade, counts: sessionLogs.gradeCounts, record: sessionLogs.record, journalSeenAt: sessionLogs.journalSeenAt })
    .from(sessionLogs)
    .where(eq(sessionLogs.sessionId, sessionId));
  const threads = await db
    .select({ id: sessionLogThreads.threadId, parent: sessionLogThreads.parentThreadId, record: sessionLogThreads.record })
    .from(sessionLogThreads)
    .where(eq(sessionLogThreads.sessionId, sessionId))
    .orderBy(asc(sessionLogThreads.threadId));
  const messages = await db
    .select({ id: sessionLogMessages.messageId, thread: sessionLogMessages.threadId, seq: sessionLogMessages.seq, rev: sessionLogMessages.rev, generation: sessionLogMessages.generation, hash: sessionLogMessages.contentHash, deletedAt: sessionLogMessages.deletedAt, record: sessionLogMessages.record })
    .from(sessionLogMessages)
    .where(eq(sessionLogMessages.sessionId, sessionId))
    .orderBy(asc(sessionLogMessages.threadId), asc(sessionLogMessages.seq));
  return { log, threads, messages };
}

async function deleteLog(sessionId: string) {
  await db.delete(sessionLogMessages).where(eq(sessionLogMessages.sessionId, sessionId));
  await db.delete(sessionLogThreads).where(eq(sessionLogThreads.sessionId, sessionId));
  await db.delete(sessionLogs).where(eq(sessionLogs.sessionId, sessionId));
}

const hasLog = async (sessionId: string) => (await db.select({ id: sessionLogs.sessionId }).from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId))).length > 0;
const logCount = async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from kortix.session_logs`))[0]!.n;

const stateRow = async () => (await db.execute<{ state: Record<string, unknown>; rev: number }>(sql`select state, rev from kortix.session_log_backfill_state`))[0];

/** The sum of one count over the ticks of a pass. */
const total = (ticks: Array<{ counts: Record<string, number> }>, key: string) => ticks.reduce((n, t) => n + t.counts[key]!, 0);

/** One full pass: ticks until the queue reports no more. */
async function pass(mode: 'dry' | 'write', opts: Parameters<typeof backfillSessionLogs>[1] = {}) {
  const ticks = [];
  for (let i = 0; i < 100; i++) {
    const tick = await backfillSessionLogs(mode, opts);
    ticks.push(tick);
    if (!tick.more) return ticks;
  }
  throw new Error('the pass did not end');
}

beforeAll(async () => {
  project = await seedProject('session-log-backfill');
});

// Every test starts with an empty queue and no pass: the backfill selects across the whole database.
afterEach(async () => {
  await db.execute(sql`delete from kortix.session_log_backfill_state`);
  await db.execute(sql`delete from kortix.session_transcript_mirrors m where not exists (select 1 from kortix.session_logs l where l.session_id = m.session_id)`);
});

afterAll(async () => {
  await removeSeeded([project]);
});

describe('write: a mirror-only session gets the log the capture would write', () => {
  test('rows, seqs, revs, threads, grade and grade counts equal writeSessionLogFromMirror of the same session', async () => {
    const session = await oldSession(synthetic());
    const [tick] = await pass('write');
    expect(tick!.counts).toMatchObject({ sessions: 1, logs: 1, skipped: 0, failed: 0 });
    const viaBackfill = await snapshot(session);
    expect(viaBackfill.messages.length).toBeGreaterThan(0);
    expect(viaBackfill.messages.every((m) => m.generation === 0 && m.rev < 2 ** 31 && m.deletedAt === null)).toBe(true);
    expect(viaBackfill.log?.journalSeenAt).toBeNull();
    // No runtime projection: the harness is opencode, as the capture defaults it.
    expect(viaBackfill.log?.harness).toBe('opencode');
    const expected = await fromMirror(session);
    expect(viaBackfill.log?.grade).toBe(expected.restore_grade);
    expect(viaBackfill.log?.counts).toEqual(expected.grade_counts!);

    await deleteLog(session);
    expect(await writeSessionLogFromMirror(session)).toMatchObject({ outcome: 'written' });
    expect(await snapshot(session)).toEqual(viaBackfill);
  });

  test('idempotent: a second pass selects nothing and changes no row', async () => {
    const a = await oldSession([plain(0), plain(1)]);
    const b = await oldSession([plain(0), plain(1), plain(2), plain(3)]);
    await pass('write');
    const before = [await snapshot(a), await snapshot(b)];
    const [again] = await pass('write');
    expect(again!.counts.sessions).toBe(0);
    expect([await snapshot(a), await snapshot(b)]).toEqual(before);
  });

  test('a 300 kB text is offloaded as the capture offloads it', async () => {
    const session = await oldSession([plain(0), plain(1, '€'.repeat(100_000))]);
    const [tick] = await pass('write');
    expect(tick!.counts.offload_texts).toBe(1);
    const row = (await snapshot(session)).messages.find((m) => m.id === 'msg_000001')!;
    expect((row.record.blocks as Array<{ ref?: string }>)[0]!.ref).toMatch(/^kortix-attachment:\/\//);
  });
});

describe('a tool call the old mirror stripped (before 2026-09-28) converts as the v1 read serves it', () => {
  /** `plain(n)` plus one settled call without `state.input`, as the old mirror stored it. */
  const withStrippedCall = (n: number, tool: string, title: string) => {
    const m = plain(n);
    const t = 1_790_000_000_000 + n * 1000;
    m.parts.push({
      id: `prt_${n}_call`, sessionID: ROOT, messageID: m.info.id, type: 'tool', callID: `call_${n}`, tool,
      state: { status: 'completed', title, metadata: { exit: 0, output: `out ${n}\n` }, time: { start: t, end: t + 5 } },
    });
    return m;
  };
  type Call = { type: string; input: unknown; result?: { content: Array<{ type: string; text?: string }> } };
  const callOf = async (sessionId: string, messageId: string) =>
    ((await snapshot(sessionId)).messages.find((m) => m.id === messageId)!.record.blocks as Call[]).find((b) => b.type === 'tool_call')!;

  test('a stripped bash call gets input.command = title and its output; every call recoverable: grade converted, dry round trip exact', async () => {
    const session = await oldSession([plain(0), withStrippedCall(1, 'bash', 'ls -la /workspace')]);
    const [dry] = await pass('dry');
    expect(dry!.counts).toMatchObject({ logs: 1, converted: 1, partial: 0, tool_input: 0, roundtrip_mismatch_sessions: 0 });
    const [write] = await pass('write');
    expect(write!.counts).toMatchObject({ logs: 1, converted: 1, partial: 0, tool_input: 0 });
    const call = await callOf(session, 'msg_000001');
    expect(call.input).toEqual({ command: 'ls -la /workspace' });
    expect(call.result?.content).toContainEqual({ type: 'text', text: 'out 1\n' });
    expect((await snapshot(session)).log).toMatchObject({ grade: 'converted', counts: { tool_input: 0, cut_point: 0, attachment: 0 } });
  });

  test('a stripped call whose title proves no input stays as stored: grade partial, tool_input 1', async () => {
    const session = await oldSession([plain(0), withStrippedCall(1, 'bash', 'ls'), withStrippedCall(3, 'execute_command', 'ls')]);
    const [write] = await pass('write');
    expect(write!.counts).toMatchObject({ logs: 1, converted: 0, partial: 1, tool_input: 1 });
    expect((await callOf(session, 'msg_000003')).input).toBeNull();
    expect((await snapshot(session)).log).toMatchObject({ grade: 'partial', counts: { tool_input: 1 } });
  });
});

describe('selection', () => {
  test('a soft-deleted session is skipped: no log, not counted', async () => {
    const deleted = await oldSession([plain(0), plain(1)]);
    await db.update(projectSessions).set({ metadata: { deletedAt: new Date().toISOString() } }).where(eq(projectSessions.sessionId, deleted));
    const [tick] = await pass('write');
    expect(tick!.counts.sessions).toBe(0);
    expect(await hasLog(deleted)).toBe(false);
    await db.delete(projectSessions).where(eq(projectSessions.sessionId, deleted));
  });

  test('a session with a journal is not selected; its rows stay the journal rows', async () => {
    const session = await oldSession([plain(0), plain(1)]);
    const { threads, ...log } = await fromMirror(session);
    const producer = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1.0.0' };
    const journal = await ingestSessionLogJournal(
      { sessionId: session, projectId: project.project_id, accountId: project.account_id },
      { generation: 0, session: log, threads: threads.map(({ messages: _m, ...t }) => t), puts: threads.flatMap((t) => t.messages.map((m, i) => ({ rev: 1_791_681_474_704_000 + i, message: { ...m, producer } }))), tombstones: [] },
    );
    expect(journal.status).toBe(200);
    const before = await snapshot(session);
    const [tick] = await pass('write');
    expect(tick!.counts.sessions).toBe(0);
    expect(await snapshot(session)).toEqual(before);
  });

  test('a session the capture wrote between the selection and the conversion is skipped, not written twice', async () => {
    const session = await oldSession([plain(0), plain(1)]);
    let captured: Awaited<ReturnType<typeof snapshot>> | undefined;
    const [tick] = await pass('write', {
      convert: async (id, opts) => {
        await writeSessionLogFromMirror(id); // the capture of a turn end, meanwhile
        captured = await snapshot(id);
        return writeSessionLogFromMirror(id, opts);
      },
    });
    expect(tick!.counts).toMatchObject({ sessions: 1, logs: 0, skipped: 1, failed: 0 });
    expect(captured!.messages.map((m) => m.rev)).toEqual([1, 2]);
    expect(await snapshot(session)).toEqual(captured!);
  });

  test('a mirror without rows is not selected', async () => {
    const empty = await oldSession([]);
    const [tick] = await pass('write');
    expect(tick!.counts.sessions).toBe(0);
    expect(await hasLog(empty)).toBe(false);
  });

  test('bounded batches, oldest created_at first', async () => {
    const order: string[] = [];
    const ids: string[] = [];
    // Created newest first, so insertion order is not the answer.
    for (let i = BACKFILL_BATCH_SIZE; i >= 0; i--) ids.unshift(await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + i * 60_000) }));
    const convert = (id: string, opts?: { dry?: boolean }) => (order.push(id), writeSessionLogFromMirror(id, opts));
    const first = await backfillSessionLogs('write', { convert });
    expect(first.counts.sessions).toBe(BACKFILL_BATCH_SIZE);
    expect(first.more).toBe(true);
    expect(order).toEqual(ids.slice(0, BACKFILL_BATCH_SIZE));
    const second = await backfillSessionLogs('write', { convert });
    expect(second.counts.sessions).toBe(1);
    expect(second.more).toBe(false);
    expect(order).toEqual(ids);
    expect(await logCount()).toBeGreaterThanOrEqual(ids.length);
  });

  test('the time budget stops a batch after the session that crossed it; the next tick goes on from there', async () => {
    const ids = [
      await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 1000) }),
      await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 2000) }),
      await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 3000) }),
    ];
    const first = await backfillSessionLogs('write', { budgetMs: 0 });
    expect(first.counts.sessions).toBe(1);
    expect(first.more).toBe(true);
    expect([await hasLog(ids[0]!), await hasLog(ids[1]!), await hasLog(ids[2]!)]).toEqual([true, false, false]);
    const rest = await pass('write');
    expect(rest.reduce((n, t) => n + t.counts.sessions, 0)).toBe(2);
    expect(await hasLog(ids[2]!)).toBe(true);
  });
});

describe('the pass lives in the database, not in the leader', () => {
  const passRow = async () => (await db.execute<{ state: { mode: string; after: { sessionId: string } | null; totals: { sessions: number }; dryDone: boolean }; rev: number }>(sql`select state, rev from kortix.session_log_backfill_state`))[0];

  test('a new leader resumes the cursor and the totals: one dry pass, one summary over every session', async () => {
    const ids = [1, 2, 3].map((n) => oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + n * 1000) }));
    const [a, b, c] = (await Promise.all(ids)) as [string, string, string];
    const order: string[] = [];
    const convert = (id: string, opts?: { dry?: boolean }) => (order.push(id), writeSessionLogFromMirror(id, opts));
    const info = spyOn(logger, 'info');
    try {
      // Leader 1 converts one session (the budget cuts the tick), then its task stops.
      expect((await backfillSessionLogs('dry', { budgetMs: 0, convert })).more).toBe(true);
      expect(await passRow()).toMatchObject({ rev: 1, state: { mode: 'dry', after: { sessionId: a }, totals: { sessions: 1 }, dryDone: false } });
      // Leader 2 holds no memory of it: it reads the row and goes on after `a`.
      await pass('dry', { convert });
      expect(order).toEqual([a, b, c]);
      const summary = info.mock.calls.find(([msg]) => msg === '[session-log] backfill pass complete');
      expect(summary?.[1]).toMatchObject({ mode: 'dry', sessions: 3, logs: 3 });
      expect((await passRow())?.state).toMatchObject({ mode: 'dry', after: null, dryDone: true });
      // The dry pass ran once: a later leader converts nothing.
      expect((await backfillSessionLogs('dry', { convert })).counts.sessions).toBe(0);
      expect(order).toHaveLength(3);
    } finally {
      info.mockRestore();
    }
  });

  test('a tick whose row moved under it (an old leader, late) does not save its cursor', async () => {
    const a = await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 1000) });
    await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 2000) });
    await backfillSessionLogs('dry', { budgetMs: 0 });
    const warn = spyOn(logger, 'warn');
    try {
      // Meanwhile the new leader saves (rev 2): this tick loaded rev 1.
      const late = await backfillSessionLogs('dry', {
        budgetMs: 0,
        convert: async (id, opts) => {
          await db.execute(sql`update kortix.session_log_backfill_state set rev = rev + 1`);
          return writeSessionLogFromMirror(id, opts);
        },
      });
      expect(late.counts.sessions).toBe(1);
      expect(warn.mock.calls.map(([msg]) => msg)).toContain('[session-log] backfill state changed under this tick; its cursor is not saved');
      expect(await passRow()).toMatchObject({ rev: 2, state: { after: { sessionId: a }, totals: { sessions: 1 } } });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('dry runs once per build', () => {
  test('a completed dry pass skips on the same build (one info line per process) and runs again on a new build', async () => {
    const session = await oldSession([plain(0), plain(1)]);
    const commit = config.KORTIX_COMMIT;
    const info = spyOn(logger, 'info');
    try {
      config.KORTIX_COMMIT = 'build-a';
      expect(total(await pass('dry'), 'sessions')).toBe(1);
      expect((await backfillSessionLogs('dry')).counts.sessions).toBe(0);
      expect((await backfillSessionLogs('dry')).counts.sessions).toBe(0);
      const done = info.mock.calls.filter(([msg]) => String(msg).startsWith('[session-log] backfill dry pass already complete'));
      expect(done).toHaveLength(1);
      expect(String(done[0]![0])).toContain('DELETE FROM kortix.session_log_backfill_state');
      config.KORTIX_COMMIT = 'build-b';
      const again = await pass('dry');
      expect([total(again, 'sessions'), total(again, 'logs')]).toEqual([1, 1]);
      expect(await hasLog(session)).toBe(false);
    } finally {
      config.KORTIX_COMMIT = commit;
      info.mockRestore();
    }
  });
});

describe('size cap: a mirror over the capture cap is converted by the backfill in a thread, never by the capture', () => {
  // Random hex: pglz cannot shrink it, so `pg_column_size` is close to the JSON length.
  const incompressible = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n / 2))).toString('hex');

  test('the capture answers too_large; the backfill counts it and converts it in a Worker, dry and write; the log equals the uncapped conversion', async () => {
    const large = await oldSession([...synthetic(), plain(1000, incompressible(6_000)), plain(1001)], { createdAt: new Date(T0 + 1000) });
    const small = await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 2000) });
    const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
    config.SESSION_LOG_RESTORE_MAX_BYTES = 4_000; // mirrorStoredCap() = 2,000 stored bytes; the thread's own config keeps the default
    try {
      expect(await writeSessionLogFromMirror(large, { dry: true })).toEqual({ outcome: 'too_large' });
      expect(await writeSessionLogFromMirror(large)).toEqual({ outcome: 'too_large' });
      const dry = await pass('dry');
      const keys = ['sessions', 'too_large', 'logs', 'failed', 'roundtrip_mismatch_sessions'];
      expect(keys.map((k) => total(dry, k))).toEqual([2, 1, 2, 0, 0]);
      const expected = await fromMirror(large);
      expect(total(dry, 'messages')).toBe(expected.threads.flatMap((t) => t.messages).length + 2);
      expect([await hasLog(large), await hasLog(small)]).toEqual([false, false]);
      const write = await pass('write');
      expect(keys.map((k) => total(write, k))).toEqual([2, 1, 2, 0, 0]);
      expect([await hasLog(large), await hasLog(small)]).toEqual([true, true]);
      // A thread that answered leaves no session in progress and no crash behind.
      expect((await stateRow())?.state).toMatchObject({ threadStarted: null, threadCrashes: {} });
      const viaThread = await snapshot(large);
      expect(viaThread.log).toMatchObject({ grade: expected.restore_grade, counts: expected.grade_counts });
      await deleteLog(large);
      expect(await writeSessionLogFromMirror(large, { uncapped: true })).toMatchObject({ outcome: 'written' });
      expect(await snapshot(large)).toEqual(viaThread);
    } finally {
      config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
    }
  });

  describe('the conversion thread can never take the leader down twice', () => {
    const withCap = async (f: () => Promise<void>) => {
      const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
      config.SESSION_LOG_RESTORE_MAX_BYTES = 4_000;
      try {
        await f();
      } finally {
        config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
      }
    };
    const createdAtOf = async (id: string) =>
      (await db.execute<{ c: string }>(sql`select created_at::text as c from kortix.project_sessions where session_id = ${id}`))[0]!.c;
    /** The row a write tick saves right before it starts `sessionId`'s thread (its cursor on that session). */
    const savedBeforeThread = async (sessionId: string | null, threadCrashes: Record<string, number>, after: string | null) => {
      const state = { ...newBackfillState('write'), after: after ? { createdAt: await createdAtOf(after), sessionId: after } : null, threadStarted: sessionId, threadCrashes };
      await db.execute(sql`insert into kortix.session_log_backfill_state (id, state, rev) values ('pass', ${JSON.stringify(state)}::jsonb, 1)`);
    };

    test('a thread whose process died: its session counts failed once (warn, no id), the cursor is past it; the next pass tries it once more', async () => {
      const large = await oldSession([plain(0), plain(1, incompressible(6_000))], { createdAt: new Date(T0 + 1000) });
      const next = await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 2000) });
      await savedBeforeThread(large, {}, large);
      const warn = spyOn(logger, 'warn');
      await withCap(async () => {
        try {
          const crashed = await pass('write');
          expect(['sessions', 'logs', 'failed', 'too_large'].map((k) => total(crashed, k))).toEqual([1, 1, 1, 0]);
          expect([await hasLog(large), await hasLog(next)]).toEqual([false, true]);
          const lines = warn.mock.calls.filter(([msg]) => String(msg).includes('conversion thread'));
          expect(lines).toHaveLength(1);
          expect(JSON.stringify(lines)).not.toContain(large);
          expect((await stateRow())?.state).toMatchObject({ threadStarted: null, threadCrashes: { [large]: 1 } });
          // Attempt 2, in the next pass: it answers.
          const retry = await pass('write');
          expect(['sessions', 'logs', 'failed', 'too_large'].map((k) => total(retry, k))).toEqual([1, 1, 0, 1]);
          expect(await hasLog(large)).toBe(true);
        } finally {
          warn.mockRestore();
        }
      });
    });

    test('a session whose thread died twice is never started again: failed, no log', async () => {
      const large = await oldSession([plain(0), plain(1, incompressible(6_000))]);
      await savedBeforeThread(null, { [large]: 2 }, null);
      await withCap(async () => {
        const write = await pass('write');
        expect(['sessions', 'logs', 'failed', 'too_large'].map((k) => total(write, k))).toEqual([1, 0, 1, 1]);
        expect(await hasLog(large)).toBe(false);
        expect((await stateRow())?.state).toMatchObject({ threadStarted: null, threadCrashes: { [large]: 2 } });
      });
    });

    test('the memory guard: no room for the thread under 75 % of the memory limit defers the session (too_large, deferred), not converted, not failed', async () => {
      const large = await oldSession([plain(0), plain(1, incompressible(6_000))]);
      const limit = config.SESSION_LOG_BACKFILL_MEMORY_MB;
      config.SESSION_LOG_BACKFILL_MEMORY_MB = 1;
      try {
        await withCap(async () => {
          const dry = await pass('dry');
          expect(['sessions', 'logs', 'failed', 'too_large', 'deferred'].map((k) => total(dry, k))).toEqual([1, 0, 0, 1, 1]);
          const write = await pass('write');
          expect(['sessions', 'logs', 'failed', 'too_large', 'deferred'].map((k) => total(write, k))).toEqual([1, 0, 0, 1, 1]);
          expect(await hasLog(large)).toBe(false);
          expect((await stateRow())?.state).toMatchObject({ threadStarted: null, threadCrashes: {} });
        });
      } finally {
        config.SESSION_LOG_BACKFILL_MEMORY_MB = limit;
      }
      // With room again, the next pass converts it.
      await withCap(async () => {
        expect(total(await pass('write'), 'logs')).toBe(1);
      });
      expect(await hasLog(large)).toBe(true);
    });
  });

  test('a project with session_log off: a session that already has a log keeps its mirror captures past the cap, so its log never goes stale', async () => {
    const session = await oldSession([plain(0), plain(1)]);
    const setFlag = (on: boolean | null) =>
      db.update(projects).set({ metadata: on === null ? {} : { experimental: { session_log: on } } }).where(eq(projects.projectId, project.project_id));
    await setFlag(false);
    expect(await writeSessionLogFromMirror(session)).toMatchObject({ outcome: 'written' });
    const grown = plain(2, incompressible(6_000));
    await db.insert(sessionTranscriptMessages).values({
      sessionId: session, messageId: String(grown.info.id), runtimeSessionId: ROOT, role: String(grown.info.role), info: grown.info, parts: grown.parts,
      messageCreatedAt: new Date((grown.info.time as { created: number }).created),
    });
    const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
    config.SESSION_LOG_RESTORE_MAX_BYTES = 4_000;
    try {
      expect(await writeSessionLogFromMirror(session)).toMatchObject({ outcome: 'written' });
      expect((await snapshot(session)).messages.map((m) => m.id)).toContain('msg_000002');
      // With session_log on (the default) the log is the store: a mirror never converts into a log that holds a message.
      await setFlag(null);
      expect(await writeSessionLogFromMirror(session)).toEqual({ outcome: 'skipped' });
    } finally {
      config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
      await setFlag(null);
    }
  });
});

describe('failures', () => {
  test('a failing session is counted and skipped, the rest proceed, and the next pass retries it once', async () => {
    const ids = [
      await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 1000) }),
      await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 2000) }),
      await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 3000) }),
    ];
    const [thrower, refused, fine] = ids as [string, string, string];
    const calls: string[] = [];
    const ticks = await pass('write', {
      convert: async (id, opts) => {
        calls.push(id);
        if (id === thrower) throw new Error('synthetic conversion failure');
        if (id === refused) return { outcome: 'failed' as const, status: 422 };
        return writeSessionLogFromMirror(id, opts);
      },
    });
    // One pass visits each session once: no loop on a failing one.
    expect(calls).toEqual(ids);
    expect(ticks.reduce((n, t) => n + t.counts.failed, 0)).toBe(2);
    expect(ticks.reduce((n, t) => n + t.counts.logs, 0)).toBe(1);
    expect(await hasLog(fine)).toBe(true);
    expect(await hasLog(thrower)).toBe(false);
    // The pass ended: the next one starts from the oldest again, and the real path converts both.
    const [retry] = await pass('write');
    expect(retry!.counts).toMatchObject({ sessions: 2, logs: 2, failed: 0 });
  });
});

describe('races and switches', () => {
  test('a restore claim (generation 1) between the selection and the conversion: the generation-0 write is skipped', async () => {
    const session = await oldSession([plain(0), plain(1)]);
    const scope = { sessionId: session, projectId: project.project_id, accountId: project.account_id };
    let claimed: Awaited<ReturnType<typeof snapshot>> | undefined;
    const [tick] = await pass('write', {
      convert: async (id, opts) => {
        // Meanwhile: a capture writes the log, a fresh box claims it (generation 1), and the mirror gains a turn.
        await writeSessionLogFromMirror(id);
        expect(await claimSessionLog(scope)).not.toBeNull();
        await db.insert(sessionTranscriptMessages).values([plain(2), plain(3)].map((m) => ({
          sessionId: id, messageId: String(m.info.id), runtimeSessionId: ROOT, role: String(m.info.role), info: m.info, parts: m.parts,
          messageCreatedAt: new Date((m.info.time as { created: number }).created),
        })));
        await db.update(sessionTranscriptMirrors).set({ capturedAt: new Date() }).where(eq(sessionTranscriptMirrors.sessionId, id));
        claimed = await snapshot(id);
        return writeSessionLogFromMirror(id, opts);
      },
    });
    expect(claimed!.log?.generation).toBe(1);
    expect(tick!.counts).toMatchObject({ sessions: 1, logs: 0, skipped: 1, failed: 0 });
    expect(await snapshot(session)).toEqual(claimed!);
  });

  test('write with SESSION_LOG_INGEST_ENABLED=false skips every session and warns once per pass', async () => {
    const a = await oldSession([plain(0), plain(1)]);
    const b = await oldSession([plain(0), plain(1)]);
    const warn = spyOn(logger, 'warn');
    config.SESSION_LOG_INGEST_ENABLED = false;
    try {
        const first = await backfillSessionLogs('write', { budgetMs: 0 });
      const rest = await pass('write');
      const all = [first, ...rest];
      expect(all.reduce((n, t) => n + t.counts.skipped, 0)).toBe(2);
      expect(all.reduce((n, t) => n + t.counts.logs, 0)).toBe(0);
      expect([await hasLog(a), await hasLog(b)]).toEqual([false, false]);
      const warnings = () => warn.mock.calls.filter(([msg]) => String(msg).includes('SESSION_LOG_INGEST_ENABLED=false'));
      expect(warnings()).toHaveLength(1);
      // The next pass warns again, once.
      await pass('write');
      expect(warnings()).toHaveLength(2);
    } finally {
      config.SESSION_LOG_INGEST_ENABLED = true;
      warn.mockRestore();
    }
  });
});

describe('dry: converts in memory, writes nothing, reports the counts', () => {
  test('no row, no object; the counts are those of fromV1; info lines carry no session id; the pass ends with a summary', async () => {
    const big = await oldSession([...synthetic(), plain(1000, '€'.repeat(100_000)), plain(1001)]);
    const small = await oldSession([plain(0), plain(1)]);
    const objectsBefore = bucket.objects.size;
    const info = spyOn(logger, 'info');
    try {
        const ticks = await pass('dry');
      expect(await hasLog(big)).toBe(false);
      expect(await hasLog(small)).toBe(false);
      expect(bucket.objects.size).toBe(objectsBefore);

      const logs = [await fromMirror(big), await fromMirror(small)];
      const messages = logs.flatMap((l) => l.threads.flatMap((t) => t.messages));
      const grades = { native: 0, converted: 0, partial: 0 };
      for (const l of logs) grades[l.restore_grade as keyof typeof grades]++;
      const sum = (k: 'tool_input' | 'cut_point' | 'attachment') => logs.reduce((n, l) => n + l.grade_counts![k], 0);
      expect(ticks).toHaveLength(1);
      const lines = info.mock.calls.filter(([msg]) => String(msg).includes('backfill'));
      expect(lines.map(([msg]) => msg)).toEqual(['[session-log] backfill tick', '[session-log] backfill pass complete']);
      const bytesOf = (l: SessionLog) => l.threads.flatMap((t) => t.messages).reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0);
      const sizeOf = (l: SessionLog) => l.threads.flatMap((t) => t.messages).length;
      const { pass_ms, max_session_ms, ...summary } = lines[1]![1] as Record<string, unknown>;
      expect(pass_ms as number).toBeGreaterThanOrEqual(max_session_ms as number);
      expect(max_session_ms as number).toBeGreaterThanOrEqual(0);
      expect(summary).toEqual({
        mode: 'dry',
        sessions: 2,
        logs: 2,
        skipped: 0,
        failed: 0,
        too_large: 0,
        deferred: 0,
        messages: messages.length,
        ...grades,
        tool_input: sum('tool_input'),
        cut_point: sum('cut_point'),
        attachment: sum('attachment'),
        record_bytes: messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0),
        offload_texts: 1,
        // Neither session has a runtime projection, and both roots are OpenCode ids.
        harness_defaulted: 2,
        harness_inferred_pi: 0,
        validation_failed: 0,
        roundtrip_mismatch_sessions: 0,
        roundtrip_mismatch_messages: 0,
        max_session_messages: Math.max(...logs.map(sizeOf)),
        max_session_record_bytes: Math.max(...logs.map(bytesOf)),
      });
      expect(grades.partial).toBeGreaterThan(0);
      // The tick line carries the same counts.
      expect(lines[0]![1]).toMatchObject({ mode: 'dry', sessions: 2, harness_defaulted: 2, max_session_messages: Math.max(...logs.map(sizeOf)) });
      expect(JSON.stringify(lines)).not.toContain(big);
      expect(JSON.stringify(lines)).not.toContain(small);

      // One dry pass: a later tick selects and converts nothing and logs nothing.
      let converted = 0;
      const again = await backfillSessionLogs('dry', { convert: async (id, opts) => (converted++, writeSessionLogFromMirror(id, opts)) });
      expect(again).toEqual({ more: false, counts: expect.objectContaining({ sessions: 0, logs: 0 }) });
      expect(converted).toBe(0);
      expect(info.mock.calls.filter(([msg]) => String(msg).includes('backfill') && !String(msg).includes('already complete'))).toHaveLength(2);
      // A mode change starts over: a write pass converts both.
      const [write] = await pass('write');
      expect(write!.counts).toMatchObject({ sessions: 2, logs: 2 });
    } finally {
      info.mockRestore();
    }
  });
});

describe('harness: the runtime projection, else the root id shape, else opencode', () => {
  // pi mints its root as `ses_pi` + 24 hex (`mintRootId`, kortixd `harness/pi/message-id.ts`).
  // An OpenCode id is `ses_` + 12 hex clock chars + 14 base62, so it never starts with `ses_pi`.
  const PI_ROOT = 'ses_pi0123456789abcdef01234567';

  test('no projection and a pi-minted root: the log is pi (harness_inferred_pi); an OpenCode root stays opencode (harness_defaulted)', async () => {
    const pi = await oldSession([plain(0, 'hi', PI_ROOT), plain(1, 'hello', PI_ROOT)], { root: PI_ROOT });
    const oc = await oldSession([plain(0), plain(1)]);
    const dry = await pass('dry');
    expect([total(dry, 'harness_inferred_pi'), total(dry, 'harness_defaulted')]).toEqual([1, 1]);

    const write = await pass('write');
    expect([total(write, 'logs'), total(write, 'harness_inferred_pi'), total(write, 'harness_defaulted')]).toEqual([2, 1, 1]);
    const piLog = await snapshot(pi);
    expect(piLog.log?.harness).toBe('pi');
    // fromV1 keys its v1 ext by the harness.
    expect(piLog.threads.map((t) => Object.keys((t.record as { ext: object }).ext))).toEqual([['pi']]);
    expect((await snapshot(oc)).log?.harness).toBe('opencode');
  });

  test('a mirror without a root id is opencode (harness_defaulted)', async () => {
    const session = await oldSession([plain(0, 'hi', PI_ROOT), plain(1, 'hello', PI_ROOT)], { root: null });
    const write = await pass('write');
    expect([total(write, 'harness_inferred_pi'), total(write, 'harness_defaulted')]).toEqual([0, 1]);
    expect((await snapshot(session)).log?.harness).toBe('opencode');
  });
});

describe('validation: every converted log is checked with SessionLogSchema', () => {
  test('a log that fails validation is counted validation_failed, in dry and in write, and is never written; the others are', async () => {
    const bad = await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 1000) });
    const good = await oldSession([plain(0), plain(1)], { createdAt: new Date(T0 + 2000) });
    const original = SessionLogSchema.safeParse.bind(SessionLogSchema);
    const parse = spyOn(SessionLogSchema, 'safeParse').mockImplementation(((input: { session_id?: string }) =>
      input?.session_id === bad ? { success: false, error: new ZodError([]) } : original(input)) as never);
    try {
      const dry = await pass('dry');
      expect([total(dry, 'sessions'), total(dry, 'logs'), total(dry, 'validation_failed'), total(dry, 'failed')]).toEqual([2, 1, 1, 0]);
      const write = await pass('write');
      expect([total(write, 'sessions'), total(write, 'logs'), total(write, 'validation_failed'), total(write, 'failed')]).toEqual([2, 1, 1, 0]);
      expect([await hasLog(bad), await hasLog(good)]).toEqual([false, true]);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('display round trip: toV1(fromV1(rows)) against the stored rows', () => {
  test('roundTripMismatches counts each stored row toV1 does not give back exactly; key order does not count', async () => {
    const rows = [plain(0), plain(1), plain(2), plain(3)].map((m) => ({ runtime_session_id: ROOT, info: m.info, parts: m.parts }) as unknown as V1Row);
    const log = fromV1({ session_id: 's', root_id: ROOT, rows });
    expect(await roundTripMismatches(log, rows)).toBe(0);
    // Reversed key order on every object: equal (jsonb stores its own key order).
    const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v);
    expect(await roundTripMismatches(log, rows.map(reorder) as V1Row[])).toBe(0);
    // One changed text, and one stored row the log does not hold.
    const changed = structuredClone(rows);
    (changed[1]!.parts[0] as { text: string }).text = 'edited';
    expect(await roundTripMismatches(log, changed)).toBe(1);
    expect(await roundTripMismatches(log, [...rows, { ...rows[0]!, info: { ...rows[0]!.info, id: 'msg_extra' } } as V1Row])).toBe(1);
  });

  test('dry over a database seeded from the P1 fixtures: 0 failed, 0 validation failures, 0 round-trip mismatches', async () => {
    // The 7 v2 fixtures the P1 validators run on (`session-log.test.ts`), as the v1 mirror `toV1` makes of them,
    // plus the synthetic OpenCode session with a child.
    const dir = join(import.meta.dir, '../../../../packages/api-contract/src/__tests__/fixtures/session-log');
    const names = ['pi', 'opencode', 'opencode-v2', 'claude-code', 'codex', 'golden', 'golden21'];
    for (const name of names) {
      const v1 = toV1(JSON.parse(readFileSync(join(dir, `${name}.v2.json`), 'utf8')) as SessionLog);
      expect(v1.rows.length).toBeGreaterThan(0);
      await oldSession(v1.rows.map((r) => ({ info: r.info as never, parts: r.parts as never, runtime_session_id: r.runtime_session_id })), { root: v1.root_id });
    }
    await oldSession(synthetic());
    const dry = await pass('dry');
    const keys = ['sessions', 'logs', 'failed', 'skipped', 'validation_failed', 'roundtrip_mismatch_sessions', 'roundtrip_mismatch_messages'];
    expect(Object.fromEntries(keys.map((k) => [k, total(dry, k)]))).toEqual({
      sessions: names.length + 1,
      logs: names.length + 1,
      failed: 0,
      skipped: 0,
      validation_failed: 0,
      roundtrip_mismatch_sessions: 0,
      roundtrip_mismatch_messages: 0,
    });
    expect(total(dry, 'messages')).toBeGreaterThan(0);
  });
});
