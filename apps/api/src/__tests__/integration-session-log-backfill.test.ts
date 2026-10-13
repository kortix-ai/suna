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
import { fromV1, type SessionLog, type V1Row } from '@kortix/api-contract/session-log';
import {
  projectSessions,
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

const { backfillSessionLogs, newBackfillState, BACKFILL_BATCH_SIZE } = await import('../projects/session-log-backfill');
const { writeSessionLogFromMirror } = await import('../projects/session-log-capture');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_backfillroot00000000001';
const CHILD = 'ses_backfillchild0000000001';
const T0 = Date.parse('2025-01-01T00:00:00.000Z');

let project: SeededProject;

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

/** A small root history: user/assistant pairs, `msg_<n>` created at n seconds. */
const plain = (n: number, text = `reply ${n}`): Msg => {
  const id = `msg_${String(n).padStart(6, '0')}`;
  const created = 1_790_000_000_000 + n * 1000;
  const info: Record<string, unknown> =
    n % 2 === 0
      ? { id, sessionID: ROOT, role: 'user', time: { created }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } }
      : { id, sessionID: ROOT, role: 'assistant', parentID: `msg_${String(n - 1).padStart(6, '0')}`, time: { created, completed: created + 500 }, providerID: 'kortix', modelID: 'm', finish: 'stop' };
  return { info, parts: [{ id: `prt_${n}`, sessionID: ROOT, messageID: id, type: 'text', text }] };
};

/** An old session: a mirror and its rows, no session log. `createdAt` orders the backfill. */
async function oldSession(messages: Msg[], opts: { createdAt?: Date } = {}): Promise<string> {
  const sessionId = await seedSession(project, OWNER);
  if (opts.createdAt) await db.update(projectSessions).set({ createdAt: opts.createdAt }).where(eq(projectSessions.sessionId, sessionId));
  await db.insert(sessionTranscriptMirrors).values({ sessionId, projectId: project.project_id, accountId: project.account_id, runtimeSessionId: ROOT });
  if (messages.length === 0) return sessionId;
  await db.insert(sessionTranscriptMessages).values(
    messages.map((m) => ({
      sessionId,
      messageId: String(m.info.id),
      runtimeSessionId: String(m.info.sessionID),
      role: String(m.info.role),
      info: m.info,
      parts: m.parts,
      messageCreatedAt: new Date((m.info.time as { created: number }).created),
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

/** One full pass: ticks until the queue reports no more. */
async function pass(mode: 'dry' | 'write', state = newBackfillState(), opts: Parameters<typeof backfillSessionLogs>[2] = {}) {
  const ticks = [];
  for (let i = 0; i < 100; i++) {
    const tick = await backfillSessionLogs(mode, state, opts);
    ticks.push(tick);
    if (!tick.more) return ticks;
  }
  throw new Error('the pass did not end');
}

beforeAll(async () => {
  project = await seedProject('session-log-backfill');
});

// Every test starts with an empty queue: the backfill selects across the whole database.
afterEach(async () => {
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
    const [tick] = await pass('write', newBackfillState(), {
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
    const state = newBackfillState();
    const convert = (id: string, opts?: { dry?: boolean }) => (order.push(id), writeSessionLogFromMirror(id, opts));
    const first = await backfillSessionLogs('write', state, { convert });
    expect(first.counts.sessions).toBe(BACKFILL_BATCH_SIZE);
    expect(first.more).toBe(true);
    expect(order).toEqual(ids.slice(0, BACKFILL_BATCH_SIZE));
    const second = await backfillSessionLogs('write', state, { convert });
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
    const state = newBackfillState();
    const first = await backfillSessionLogs('write', state, { budgetMs: 0 });
    expect(first.counts.sessions).toBe(1);
    expect(first.more).toBe(true);
    expect([await hasLog(ids[0]!), await hasLog(ids[1]!), await hasLog(ids[2]!)]).toEqual([true, false, false]);
    const rest = await pass('write', state);
    expect(rest.reduce((n, t) => n + t.counts.sessions, 0)).toBe(2);
    expect(await hasLog(ids[2]!)).toBe(true);
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
    const state = newBackfillState();
    const ticks = await pass('write', state, {
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
    const [retry] = await pass('write', state);
    expect(retry!.counts).toMatchObject({ sessions: 2, logs: 2, failed: 0 });
  });
});

describe('dry: converts in memory, writes nothing, reports the counts', () => {
  test('no row, no object; the counts are those of fromV1; info lines carry no session id; the pass ends with a summary', async () => {
    const big = await oldSession([...synthetic(), plain(1000, '€'.repeat(100_000)), plain(1001)]);
    const small = await oldSession([plain(0), plain(1)]);
    const objectsBefore = bucket.objects.size;
    const info = spyOn(logger, 'info');
    try {
      const state = newBackfillState();
      const ticks = await pass('dry', state);
      expect(await hasLog(big)).toBe(false);
      expect(await hasLog(small)).toBe(false);
      expect(bucket.objects.size).toBe(objectsBefore);

      const logs = [await fromMirror(big), await fromMirror(small)];
      const messages = logs.flatMap((l) => l.threads.flatMap((t) => t.messages));
      const grades = { native: 0, converted: 0, partial: 0 };
      for (const l of logs) grades[l.restore_grade as keyof typeof grades]++;
      const sum = (k: 'tool_input' | 'cut_point' | 'attachment') => logs.reduce((n, l) => n + l.grade_counts![k], 0);
      const counts = ticks.reduce((t, x) => {
        for (const [k, v] of Object.entries(x.counts)) t[k] = (t[k] ?? 0) + v;
        return t;
      }, {} as Record<string, number>);
      expect(counts).toEqual({
        sessions: 2,
        logs: 2,
        skipped: 0,
        failed: 0,
        messages: messages.length,
        ...grades,
        tool_input: sum('tool_input'),
        cut_point: sum('cut_point'),
        attachment: sum('attachment'),
        record_bytes: messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0),
        offload_texts: 1,
      });
      expect(grades.partial).toBeGreaterThan(0);

      const lines = info.mock.calls.filter(([msg]) => String(msg).includes('backfill'));
      expect(lines.map(([msg]) => msg)).toEqual(['[session-log] backfill tick', '[session-log] backfill pass complete']);
      expect(lines[1]![1]).toMatchObject({ mode: 'dry', sessions: 2, logs: 2, offload_texts: 1 });
      expect(JSON.stringify(lines)).not.toContain(big);
      expect(JSON.stringify(lines)).not.toContain(small);

      // A dry pass is a cursor in memory: the next pass sees the same sessions again.
      const [again] = await pass('dry', state);
      expect(again!.counts.sessions).toBe(2);
    } finally {
      info.mockRestore();
    }
  });
});
