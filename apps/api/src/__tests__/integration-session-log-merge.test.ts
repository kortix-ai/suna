/**
 * Integration test (real PostgreSQL, fresh migrated database): the merge pass of the session-log
 * backfill (Release B prerequisite). A session whose log exists but lacks v1 mirror messages gets
 * them (`mergeMirrorIntoLog`, `session-log-capture.ts`), selected by the one SQL definition
 * `kortix.mirror_messages_missing_from_log`. Every session here is synthetic: mirror rows inserted
 * as an old capture left them, the log written through the journal ingest.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { fromV1, type SessionLogMessage, type V1Row } from '@kortix/api-contract/session-log';
import { projectSessions, projects, sessionLogMessages, sessionLogThreads, sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedAccount, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { syntheticOpencodeSession } from './helpers/synthetic-opencode-session';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

const { backfillSessionLogs } = await import('../projects/session-log-backfill');
const { mirrorDrained, writeSessionLogFromMirror, MIRROR_MERGE_EXT } = await import('../projects/session-log-capture');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');
const { readSessionLogPage } = await import('../projects/session-log-read');
const { purgeSessionContent } = await import('../projects/session-log-purge');
const { transferProjectOwnership } = await import('../projects/lib/project-transfer');
const { config } = await import('../config');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_mergeroot000000000001';
const CHILD = 'ses_mergechild00000000001';
const PRODUCER = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1.0.0' };
const JOURNAL_REV = 1_791_681_474_704_000;

let project: SeededProject;
const created: string[] = [];

type Row = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

/** `msg_<n>`, created at n seconds: even n a user prompt, odd n its reply. */
const plain = (n: number, text = `reply ${n}`): Row => {
  const id = `msg_${String(n).padStart(6, '0')}`;
  const at = 1_790_000_000_000 + n * 1000;
  const info: Record<string, unknown> =
    n % 2 === 0
      ? { id, sessionID: ROOT, role: 'user', time: { created: at }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } }
      : { id, sessionID: ROOT, role: 'assistant', parentID: `msg_${String(n - 1).padStart(6, '0')}`, time: { created: at, completed: at + 500 }, providerID: 'kortix', modelID: 'm', finish: 'stop' };
  return { info, parts: [{ id: `prt_${n}`, sessionID: ROOT, messageID: id, type: 'text', text }] };
};

/** The same content under other ids, as pi re-keys a message or OpenCode a compaction. */
const rekeyed = (row: Row, suffix: string): Row => {
  const id = `${row.info.id}_${suffix}`;
  const parentID = typeof row.info.parentID === 'string' ? `${row.info.parentID}_${suffix}` : row.info.parentID;
  return { info: { ...row.info, id, ...(parentID !== undefined && { parentID }) }, parts: row.parts.map((p) => ({ ...p, id: `${p.id}_${suffix}`, messageID: id })) };
};

/** A session with a mirror of `mirror` and no log. */
async function mirrored(mirror: Row[]): Promise<string> {
  const sessionId = await seedSession(project, OWNER);
  created.push(sessionId);
  await db.insert(sessionTranscriptMirrors).values({ sessionId, projectId: project.project_id, accountId: project.account_id, runtimeSessionId: ROOT });
  await db.insert(sessionTranscriptMessages).values(
    mirror.map((m) => ({
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

/**
 * The journal's log of `rows`: `fromV1` records under a native producer and journal revs. `threads`:
 * the thread rows it sends (default every one). `seqs`: per message id, the seq the journal issued.
 */
async function journaled(sessionId: string, rows: Row[], opts: { threads?: string[]; seqs?: Record<string, number> } = {}) {
  const { threads, ...session } = fromV1({ session_id: sessionId, root_id: ROOT, rows: rows.map((r) => ({ runtime_session_id: String(r.info.sessionID), ...r })) as unknown as V1Row[] });
  const sent = threads.filter((t) => !opts.threads || opts.threads.includes(t.thread_id));
  let rev = JOURNAL_REV;
  const result = await ingestSessionLogJournal(
    { sessionId, projectId: project.project_id, accountId: project.account_id },
    {
      generation: 0,
      session,
      threads: sent.map(({ messages: _m, ...t }) => t),
      puts: sent.flatMap((t) => t.messages.map((m) => ({ rev: ++rev, message: { ...m, seq: opts.seqs?.[m.message_id] ?? m.seq, producer: PRODUCER } }))),
      tombstones: [],
    },
  );
  expect(result.status).toBe(200);
}

const page = async (sessionId: string, threadId: string | null = null) => {
  const p = await readSessionLogPage({ sessionId, threadId, beforeSeq: null, limit: 200 });
  if (!p || typeof p === 'string') throw new Error(`no page: ${p}`);
  return p;
};
const ids = (messages: Array<Pick<SessionLogMessage, 'message_id'>>) => messages.map((m) => m.message_id);
const rows = (sessionId: string) =>
  db.select({ id: sessionLogMessages.messageId, thread: sessionLogMessages.threadId, seq: sessionLogMessages.seq, rev: sessionLogMessages.rev, hash: sessionLogMessages.contentHash, record: sessionLogMessages.record }).from(sessionLogMessages).where(eq(sessionLogMessages.sessionId, sessionId));
const stateRow = async () => (await db.execute<{ state: Record<string, unknown> }>(sql`select state from kortix.session_log_backfill_state`))[0]?.state;

/** The conversion pass already ran (prod and dev today): every later write tick is the merge pass. */
const drained = () =>
  db.execute(sql`insert into kortix.session_log_backfill_state (id, state, rev) values ('pass', ${JSON.stringify({ mode: 'write', drainedWithDeleted: true })}::jsonb, 1)`);

/** One full merge pass: ticks until the queue reports no more; the summed counts. */
async function pass(opts: Parameters<typeof backfillSessionLogs>[1] = {}) {
  const sum: Record<string, number> = {};
  for (let i = 0; i < 100; i++) {
    const tick = await backfillSessionLogs('write', opts);
    for (const [k, v] of Object.entries(tick.counts)) sum[k] = (sum[k] ?? 0) + v;
    if (!tick.more) return sum;
  }
  throw new Error('the pass did not end');
}

async function withMirrorHidden<T>(fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`ALTER TABLE kortix.session_transcript_mirrors RENAME TO session_transcript_mirrors_hidden`);
  await db.execute(sql`ALTER TABLE kortix.session_transcript_messages RENAME TO session_transcript_messages_hidden`);
  try {
    return await fn();
  } finally {
    await db.execute(sql`ALTER TABLE kortix.session_transcript_messages_hidden RENAME TO session_transcript_messages`);
    await db.execute(sql`ALTER TABLE kortix.session_transcript_mirrors_hidden RENAME TO session_transcript_mirrors`);
  }
}

beforeAll(async () => {
  project = await seedProject('session-log-merge');
});

afterEach(async () => {
  await db.execute(sql`delete from kortix.session_log_backfill_state`);
  if (created.length) await db.delete(projectSessions).where(inArray(projectSessions.sessionId, created.splice(0)));
});

afterAll(async () => {
  await removeSeeded([project]);
});

describe('what the merge writes', () => {
  test('the same content under another id, a compaction summary the log holds, and an empty row are not merged; the log does not change', async () => {
    const marker: Row = { info: { id: 'msg_cmp', sessionID: ROOT, role: 'user', time: { created: 1_790_000_010_000 }, agent: 'build' }, parts: [{ id: 'prt_cmp', type: 'compaction', auto: false }] };
    const summary: Row = {
      info: { id: 'msg_sum', sessionID: ROOT, role: 'assistant', parentID: 'msg_cmp', summary: true, time: { created: 1_790_000_011_000, completed: 1_790_000_011_500 }, providerID: 'kortix', modelID: 'm', finish: 'stop' },
      parts: [{ id: 'prt_sum', type: 'text', text: 'SUMMARY of the work so far.' }],
    };
    const reasoningOnly: Row = { info: { id: 'msg_think', sessionID: ROOT, role: 'assistant', parentID: 'msg_000000', time: { created: 1_790_000_012_000, completed: 1_790_000_012_100 } }, parts: [{ id: 'prt_think', type: 'reasoning', text: 'hmm' }] };
    const session = await mirrored([plain(0), plain(1), marker, summary, reasoningOnly]);
    // The journal holds msg_000001 and the compaction under other ids (as pi and OpenCode re-key them).
    await journaled(session, [plain(0), rekeyed(plain(1), 'pi'), rekeyed(marker, 'oc'), rekeyed(summary, 'oc')]);
    const classes = await db.execute<{ message_id: string; content: string }>(sql`select message_id, content from kortix.mirror_messages_missing_from_log(${`{${session}}`}::text[]) order by 1`);
    expect(classes.map((r) => [r.message_id, r.content])).toEqual([['msg_000001', 'present'], ['msg_cmp', 'empty'], ['msg_sum', 'present'], ['msg_think', 'empty']]);
    const before = await rows(session);
    await drained();
    expect(await pass()).toMatchObject({ sessions: 1, missing: 0, present: 2, empty: 2, merged: 0, failed: 0 });
    expect(await rows(session)).toEqual(before);
    expect(await stateRow()).toMatchObject({ mergedMissing: true, mergePasses: 1, mergeTotals: expect.objectContaining({ merged: 0, present: 2, empty: 2 }) });
  });

  test('a missing root message between two stored ones lands in its place when its seq is free; the /log read serves it in order, marked, out of context', async () => {
    const session = await mirrored([0, 1, 2, 3, 4, 5].map((n) => plain(n)));
    // pi issues entry positions: the missing message's seq (4) was issued and never stored.
    await journaled(session, [0, 1, 2, 4, 5].map((n) => plain(n)), { seqs: { msg_000000: 1, msg_000001: 2, msg_000002: 3, msg_000004: 5, msg_000005: 6 } });
    const before = await rows(session);
    await drained();
    expect(await pass()).toMatchObject({ sessions: 1, missing: 1, merged: 1, misplaced: 0, unplaced: 0, failed: 0 });
    const p = await page(session);
    expect(ids(p.messages)).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000003', 'msg_000004', 'msg_000005']);
    const merged = p.messages[3]!;
    expect(merged).toMatchObject({ seq: 4, thread_id: ROOT, in_context: false, producer: { harness: 'kortix-v1-import' } });
    expect(merged.ext?.[MIRROR_MERGE_EXT]).toEqual({ version: 'kortix.mirror-merge.v1' });
    expect(merged.blocks).toEqual([expect.objectContaining({ type: 'text', id: 'prt_3', text: 'reply 3' })]);
    // Every stored row is unchanged; the merged one is a capture rev.
    const after = await rows(session);
    expect(after.filter((r) => r.id !== 'msg_000003').sort((a, b) => a.seq - b.seq)).toEqual(before.sort((a, b) => a.seq - b.seq));
    expect(after.find((r) => r.id === 'msg_000003')!.rev).toBe(1);
  });

  test('no free seq in its place: the message lands right after, counted misplaced', async () => {
    const session = await mirrored([0, 1, 2, 3, 4, 5].map((n) => plain(n)));
    await journaled(session, [0, 1, 2, 4, 5].map((n) => plain(n)));
    await drained();
    expect(await pass()).toMatchObject({ merged: 1, misplaced: 1 });
    expect(ids((await page(session)).messages)).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000004', 'msg_000005', 'msg_000003']);
  });

  test('a sub-agent thread the log lacks: its thread row is created under the log root and its messages read back; a second pass merges nothing', async () => {
    const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns: 3 });
    const session = await mirrored([...root, ...child]);
    await journaled(session, [...root, ...child], { threads: [ROOT] });
    expect(await db.select().from(sessionLogThreads).where(and(eq(sessionLogThreads.sessionId, session), eq(sessionLogThreads.threadId, CHILD)))).toHaveLength(0);
    await drained();
    expect(await pass()).toMatchObject({ sessions: 1, missing: child.length, merged: child.length, threads_created: 1, failed: 0 });
    const p = await page(session, CHILD);
    expect(ids(p.messages)).toEqual(child.map((m) => String(m.info.id)));
    // The thread row is the whole conversion's: its spawner, agent and time come from rows the merge did not read in full.
    const { messages: _m, ext: wext, ...head } = fromV1({ session_id: session, root_id: ROOT, rows: [...root, ...child].map((r) => ({ runtime_session_id: String(r.info.sessionID), ...r })) as unknown as V1Row[] }).threads.find((t) => t.thread_id === CHILD)!;
    expect([head.parent_thread_id, head.spawned_by?.call_id.startsWith('call_task_')]).toEqual([ROOT, true]);
    expect(p.threads.find((t) => t.thread_id === CHILD)).toEqual({ ...head, ext: { ...wext, [MIRROR_MERGE_EXT]: { version: 'kortix.mirror-merge.v1' } } });
    // The pass found work, so the merge is not done; the next pass finds none and is.
    expect(await stateRow()).toMatchObject({ mergedMissing: false, mergePasses: 1 });
    const before = await rows(session);
    expect(await pass()).toMatchObject({ sessions: 1, missing: 0, merged: 0 });
    expect(await rows(session)).toEqual(before);
    expect(await stateRow()).toMatchObject({ mergedMissing: true, mergePasses: 2, mergeTotals: expect.objectContaining({ merged: child.length, threads_created: 1 }) });
  });
});

describe('the merge reads only the rows it writes', () => {
  /** Random hex: pglz cannot shrink it, so the mirror's stored size is close to its JSON length. */
  const incompressible = (chars: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(chars / 2))).toString('hex');
  /** Run `fn` with the capture cap and the memory limit set, then restore both. */
  async function limited<T>(limits: { capBytes: number; memoryMb: number }, fn: () => Promise<T>): Promise<T> {
    const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
    const memory = config.SESSION_LOG_BACKFILL_MEMORY_MB;
    config.SESSION_LOG_RESTORE_MAX_BYTES = limits.capBytes;
    config.SESSION_LOG_BACKFILL_MEMORY_MB = limits.memoryMb;
    try {
      return await fn();
    } finally {
      config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
      config.SESSION_LOG_BACKFILL_MEMORY_MB = memory;
    }
  }

  test('a session over the cap, with no memory room for a whole-session thread: its missing root, compaction and child-thread messages merge in place, exactly as the whole conversion gives them; the next pass sets mergedMissing', async () => {
    const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns: 3 });
    const big = plain(1000, incompressible(6_000));
    const mirror = [...root, ...child, big];
    const session = await mirrored(mirror);
    const reply = root.find((r) => r.info.role === 'assistant' && r.info.summary !== true)!;
    const marker = root.find((r) => r.parts.some((p) => p.type === 'compaction'))!;
    const summary = root.find((r) => r.info.summary === true)!;
    const childReply = child.find((r) => r.info.role === 'assistant')!;
    const lost = new Set([reply, marker, summary, childReply]);
    const whole = fromV1({ session_id: session, root_id: ROOT, rows: mirror.map((r) => ({ runtime_session_id: String(r.info.sessionID), ...r })) as unknown as V1Row[] });
    const wanted = new Map(whole.threads.flatMap((t) => t.messages).map((m) => [m.message_id, m]));
    // The journal lost a root reply, a compaction (marker and summary) and a sub-agent reply; the child thread row exists.
    // Every other message keeps the seq the whole conversion gives it, so the lost ones have a free seq in their place.
    await journaled(session, mirror.filter((r) => !lost.has(r)), { seqs: Object.fromEntries([...wanted].map(([id, m]) => [id, m.seq])) });
    const missing = await db.execute<{ message_id: string; content: string }>(sql`select message_id, content from kortix.mirror_messages_missing_from_log(${`{${session}}`}::text[]) order by 1`);
    expect(missing.map((r) => [r.message_id, r.content]).sort()).toEqual(
      [[String(reply.info.id), 'missing'], [String(marker.info.id), 'empty'], [String(summary.info.id), 'missing'], [String(childReply.info.id), 'missing']].sort(),
    );
    await drained();
    // mirrorStoredCap() = 2,000 stored bytes: the mirror is over it. 1 MB: no whole-session thread would ever fit.
    await limited({ capBytes: 4_000, memoryMb: 1 }, async () => {
      expect(await pass()).toMatchObject({ sessions: 1, missing: 3, merged: 3, too_large: 0, deferred: 0, oversize: 0, unplaced: 0, failed: 0 });
      expect(await stateRow()).toMatchObject({ mergedMissing: false });
    });
    // Every merged record is the whole-mirror conversion's message, seq included, marked and out of context.
    const rootPage = await page(session);
    const childPage = await page(session, CHILD);
    expect(ids(rootPage.messages)).toEqual(ids(whole.threads.find((t) => t.thread_id === ROOT)!.messages));
    expect(ids(childPage.messages)).toEqual(ids(whole.threads.find((t) => t.thread_id === CHILD)!.messages));
    for (const id of [reply.info.id, marker.info.id, childReply.info.id].map(String)) {
      const merged = [...rootPage.messages, ...childPage.messages].find((m) => m.message_id === id)!;
      const { in_context, ext, ...record } = merged;
      const { in_context: _wi, ext: wext, ...expected } = wanted.get(id)!;
      expect(record).toEqual(expected);
      expect(ext).toEqual({ ...wext, [MIRROR_MERGE_EXT]: { version: 'kortix.mirror-merge.v1' } });
      expect(in_context).toBe(false);
    }
    expect(rootPage.messages.find((m) => m.message_id === marker.info.id)!.blocks).toContainEqual(expect.objectContaining({ type: 'compaction', summary: 'SUMMARY up to turn 1.' }));
    await limited({ capBytes: 4_000, memoryMb: 1 }, async () => {
      expect(await pass()).toMatchObject({ sessions: 1, missing: 0, merged: 0 });
    });
    expect(await stateRow()).toMatchObject({ mergedMissing: true, mergePasses: 2, threadStarted: null, threadCrashes: {} });
    expect(await mirrorDrained()).toBe(true);
  });

  test('a sub-agent named only in a call’s output (no metadata.sessionId) still gets its own thread: its missing reply merges exactly as the whole conversion gives it', async () => {
    const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns: 3 });
    // Drop the exact link: the child is named only by the task output (`task_id: <child>`).
    for (const row of root) {
      for (const p of row.parts as { type?: string; state?: { metadata?: Record<string, unknown> } }[]) {
        if (p.type === 'tool' && p.state?.metadata) delete p.state.metadata.sessionId;
      }
    }
    const mirror = [...root, ...child, plain(1000, incompressible(6_000))];
    const session = await mirrored(mirror);
    const childReply = child.find((r) => r.info.role === 'assistant')!;
    const whole = fromV1({ session_id: session, root_id: ROOT, rows: mirror.map((r) => ({ runtime_session_id: String(r.info.sessionID), ...r })) as unknown as V1Row[] });
    const wanted = new Map(whole.threads.flatMap((t) => t.messages).map((m) => [m.message_id, m]));
    expect(whole.threads.map((t) => t.thread_id)).toContain(CHILD);
    await journaled(session, mirror.filter((r) => r !== childReply), { seqs: Object.fromEntries([...wanted].map(([id, m]) => [id, m.seq])) });
    await drained();
    await limited({ capBytes: 4_000, memoryMb: 1 }, async () => {
      expect(await pass()).toMatchObject({ sessions: 1, missing: 1, merged: 1, unplaced: 0, failed: 0 });
    });
    const childPage = await page(session, CHILD);
    expect(ids(childPage.messages)).toEqual(ids(whole.threads.find((t) => t.thread_id === CHILD)!.messages));
    const { in_context: _i, ext: _e, ...record } = childPage.messages.find((m) => m.message_id === String(childReply.info.id))!;
    const { in_context: _wi, ext: _we, ...expected } = wanted.get(String(childReply.info.id))!;
    expect(record).toEqual(expected);
  });

  test('a message too large for the process is counted oversize and warned with its session and size, and keeps the merge pending; what does not fit the cap this pass is deferred to the next', async () => {
    const huge = plain(1, incompressible(70_000)); // 12 x its ~70 kB is over 75 % of 1 MB: never fits
    const first = plain(3, incompressible(2_800));
    const second = plain(5, incompressible(2_800)); // with `first`, over the 4,000-byte cap of one merge
    const session = await mirrored([plain(0), huge, plain(2), first, plain(4), second]);
    await journaled(session, [plain(0), plain(2), plain(4)]);
    await drained();
    const warn = spyOn(logger, 'warn');
    const info = spyOn(logger, 'info');
    try {
      await limited({ capBytes: 4_000, memoryMb: 1 }, async () => {
        expect(await pass()).toMatchObject({ missing: 3, merged: 1, oversize: 1, deferred: 1, unplaced: 0, failed: 0 });
        const oversize = warn.mock.calls.filter(([m]) => String(m).includes('too large for this process'));
        expect(oversize).toHaveLength(1);
        const meta = oversize[0]![1] as { sessionId: string; messages: number; bytes: number };
        expect([meta.sessionId, meta.messages, meta.bytes > 70_000]).toEqual([session, 1, true]);
        expect(warn.mock.calls.filter(([m]) => String(m).includes('mirror merge deferred'))).toHaveLength(1);
        expect(info.mock.calls.find(([m]) => String(m).includes('merge pass complete'))![1]).toMatchObject({ oversize: 1, mergedMissing: false });
        // The oversize message blocks the merge: a person decides.
        expect(await pass()).toMatchObject({ missing: 2, merged: 1, oversize: 1, deferred: 0 });
        expect(await pass()).toMatchObject({ missing: 1, merged: 0, oversize: 1 });
        expect(await stateRow()).toMatchObject({ mergedMissing: false });
      });
      // With room, the one large message merges alone, over the cap.
      await limited({ capBytes: 4_000, memoryMb: 4096 }, async () => {
        expect(await pass()).toMatchObject({ missing: 1, merged: 1, oversize: 0 });
        expect(await pass()).toMatchObject({ missing: 0 });
      });
      expect(await stateRow()).toMatchObject({ mergedMissing: true });
      expect(ids((await page(session)).messages)).toEqual(['msg_000000', 'msg_000002', 'msg_000004', 'msg_000003', 'msg_000005', 'msg_000001']);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});

describe('the merge respects the backfill guards', () => {

  test('a session whose merge fails is retried by the next pass; the merge is done only after a pass that finds nothing', async () => {
    const session = await mirrored([0, 1, 2, 3].map((n) => plain(n)));
    await journaled(session, [0, 1, 2].map((n) => plain(n)));
    await drained();
    expect(await pass({ merge: async () => ({ outcome: 'failed' }) })).toMatchObject({ missing: 1, failed: 1, merged: 0 });
    expect(await stateRow()).toMatchObject({ mergedMissing: false });
    expect(await pass()).toMatchObject({ missing: 1, merged: 1 });
    expect(await pass()).toMatchObject({ missing: 0 });
    expect(await stateRow()).toMatchObject({ mergedMissing: true });
  });
});

describe('Release B1 gates: the mirror is read only while the merge is pending', () => {
  test('drained but not merged: the gates are open; after the merge pass, the pass, the /log read, a journal send, the purge and the transfer run with both mirror tables gone', async () => {
    const session = await mirrored([0, 1, 2, 3].map((n) => plain(n)));
    await journaled(session, [0, 1, 2].map((n) => plain(n)));
    const transferred = await seedProject('session-log-merge-transfer');
    const target = await seedAccount('session-log-merge-transfer-target');
    await drained();
    // Pending: the merge (and every B1 path, as before B1) may read the mirror.
    expect(await mirrorDrained()).toBe(false);
    expect(await pass()).toMatchObject({ merged: 1 });
    expect(await mirrorDrained()).toBe(false);
    expect(await pass()).toMatchObject({ missing: 0 });
    expect(await mirrorDrained()).toBe(true);
    const fresh = await seedSession(project, OWNER);
    created.push(fresh);
    const warn = spyOn(logger, 'warn');
    try {
      await withMirrorHidden(async () => {
        expect(await pass()).toMatchObject({ sessions: 0 });
        expect(ids((await page(session)).messages)).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000003']);
        expect(await readSessionLogPage({ sessionId: fresh, threadId: null, beforeSeq: null, limit: 50 })).toBeNull();
        expect(await writeSessionLogFromMirror(fresh)).toEqual({ outcome: 'skipped' });
        const { threads: _t, ...log } = fromV1({ session_id: fresh, root_id: ROOT, rows: [] });
        const sent = await ingestSessionLogJournal(
          { sessionId: fresh, projectId: project.project_id, accountId: project.account_id },
          { generation: 0, session: log, threads: [], puts: [], tombstones: [] },
        );
        expect(sent.status).toBe(200);
        expect(await purgeSessionContent({ store: { removeSession: async () => {} } })).toMatchObject({ failed: 0 });
        await transferProjectOwnership({ projectId: transferred.project_id, fromAccountId: transferred.account_id, toAccountId: target });
      });
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('failed'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect((await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, transferred.project_id)))[0]!.accountId).toBe(target);
    await removeSeeded([{ account_id: target, project_id: transferred.project_id }, transferred]);
  });
});
