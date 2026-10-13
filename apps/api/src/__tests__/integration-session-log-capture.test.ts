/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): the
 * capture dual-write for a box without a journal (P2.7).
 *
 * The transcript capture writes the v1 mirror and then `fromV1` of the whole
 * mirror as v2 rows (`session-log-capture.ts`), through the journal's apply
 * path. Every session here is synthetic. The Storage bucket is
 * `helpers/fake-session-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { fromV1, modelView, type SessionLog, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
import {
  accountMembers,
  projectSessions,
  projects,
  sessionLogMessages,
  sessionLogs,
  sessionLogThreads,
  sessionRuntimeProjections,
  sessionSandboxes,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
  sessionTurns,
} from '@kortix/db';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { syntheticOpencodeSession } from './helpers/synthetic-opencode-session';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { backfillSessionTranscriptMirrorOnWake, captureSessionTranscriptMirror, resetTranscriptBackfillMemoForTests } = await import('../projects/lib/session-transcript-capture');
const { claimSessionLog } = await import('../projects/session-log-restore');
const { setTranscriptRewindMarker } = await import('../projects/lib/session-transcript-mirror');
const { ingestSessionLogJournal, sessionLogContentHash, SESSION_LOG_CAPTURE_REV_LIMIT } = await import('../projects/session-log-ingest');
const { writeSessionLogFromMirror } = await import('../projects/session-log-capture');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_capturelogroot0000000001';
const CHILD = 'ses_capturelogchild000000001';
/** A daemon journal revision: max(Date.now() * 1000, last + 1). */
const REV = 1_791_681_474_704_000;
const LIMIT = 2 ** 31;

let project: SeededProject;
let ownerToken = '';
const scope = (sessionId: string) => ({ sessionId, projectId: project.project_id, accountId: project.account_id });

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

/** One capture of `payload` (the box's root messages, newest last) plus complete children. */
async function capture(sessionId: string, payload: Msg[], children: Array<{ id: string; payload: Msg[] }> = []) {
  await db.update(projectSessions).set({ runtimeSessionId: ROOT }).where(eq(projectSessions.sessionId, sessionId));
  const result = await captureSessionTranscriptMirror(sessionId, {
    readMessages: async () => ({
      opencodeSessionId: ROOT,
      payload,
      headComplete: true,
      complete: true,
      children: children.map((c) => ({ opencodeSessionId: c.id, payload: c.payload, complete: true })),
    }),
  });
  expect(result).not.toBeNull();
}

/** `fromV1` of the stored mirror rows: what the capture's v2 rows must equal. */
async function fromMirror(sessionId: string, harness: 'opencode' | 'pi' = 'opencode'): Promise<SessionLog> {
  const [mirror] = await db.select({ root: sessionTranscriptMirrors.runtimeSessionId }).from(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, sessionId));
  const rows = await db
    .select({ runtime_session_id: sessionTranscriptMessages.runtimeSessionId, info: sessionTranscriptMessages.info, parts: sessionTranscriptMessages.parts })
    .from(sessionTranscriptMessages)
    .where(eq(sessionTranscriptMessages.sessionId, sessionId));
  return fromV1({ session_id: sessionId, root_id: mirror?.root ?? null, rows: rows as unknown as V1Row[] }, { harness });
}

const logRows = (sessionId: string) =>
  db
    .select({
      id: sessionLogMessages.messageId,
      thread: sessionLogMessages.threadId,
      seq: sessionLogMessages.seq,
      rev: sessionLogMessages.rev,
      hash: sessionLogMessages.contentHash,
      deletedAt: sessionLogMessages.deletedAt,
      record: sessionLogMessages.record,
    })
    .from(sessionLogMessages)
    .where(eq(sessionLogMessages.sessionId, sessionId))
    .orderBy(asc(sessionLogMessages.threadId), asc(sessionLogMessages.seq));
const liveRows = async (sessionId: string) => (await logRows(sessionId)).filter((r) => r.deletedAt === null);
const logRow = async (sessionId: string) => (await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId)))[0];

/** The live v2 rows equal `fromV1` of the mirror: every message, seq, record and hash; every thread; the session record. */
async function expectLogEqualsFromV1(sessionId: string, harness: 'opencode' | 'pi' = 'opencode') {
  const expected = await fromMirror(sessionId, harness);
  const { threads, ...session } = expected;
  const messages = threads.flatMap((t) => t.messages);
  const rows = await liveRows(sessionId);
  expect(rows.map((r) => r.id).sort()).toEqual(messages.map((m) => m.message_id).sort());
  for (const m of messages) {
    const row = rows.find((r) => r.id === m.message_id)!;
    expect(row.record).toEqual(m as unknown as Record<string, unknown>);
    expect({ thread: row.thread, seq: row.seq }).toEqual({ thread: m.thread_id, seq: m.seq });
    expect(row.hash).toBe(sessionLogContentHash(m));
    expect(row.rev).toBeLessThan(LIMIT);
  }
  const storedThreads = await db.select({ id: sessionLogThreads.threadId, record: sessionLogThreads.record }).from(sessionLogThreads).where(eq(sessionLogThreads.sessionId, sessionId));
  for (const { messages: _m, ...t } of threads) expect(storedThreads.find((s) => s.id === t.thread_id)?.record).toEqual(t as unknown as Record<string, unknown>);
  const log = await logRow(sessionId);
  expect(log?.record).toEqual(session as unknown as Record<string, unknown>);
  expect(log?.journalSeenAt).toBeNull();
  return expected;
}

/** A small hand-made root history: user/assistant pairs, `msg_<n>` created at n seconds. */
const plain = (n: number, text = `reply ${n}`): Msg => {
  const id = `msg_${String(n).padStart(6, '0')}`;
  const role = n % 2 === 0 ? 'user' : 'assistant';
  const info: Record<string, unknown> =
    role === 'user'
      ? { id, sessionID: ROOT, role, time: { created: 1_790_000_000_000 + n * 1000 }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } }
      : { id, sessionID: ROOT, role, parentID: `msg_${String(n - 1).padStart(6, '0')}`, time: { created: 1_790_000_000_000 + n * 1000, completed: 1_790_000_000_500 + n * 1000 }, providerID: 'kortix', modelID: 'm', finish: 'stop' };
  return { info, parts: [{ id: `prt_${n}`, sessionID: ROOT, messageID: id, type: 'text', text }] };
};
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => plain(from + i));

/** The journal's batch of `fromV1` of the mirror, under producer `opencode`, as the daemon's adapter journals it. */
function journalOf(log: SessionLog, rev = REV): SessionLogJournalRequest {
  const producer = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1.0.0' };
  const { threads, ...session } = log;
  return {
    generation: 0,
    session,
    threads: threads.map(({ messages: _m, ...t }) => t),
    puts: threads.flatMap((t) => t.messages.map((m, i) => ({ rev: rev + i, message: { ...m, producer } }))),
    tombstones: [],
  };
}

const setFlag = (on: boolean) =>
  db.update(projects).set({ metadata: sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{experimental}', ${JSON.stringify({ session_log: on })}::jsonb)` }).where(eq(projects.projectId, project.project_id));

beforeAll(async () => {
  project = await seedProject('session-log-capture');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  ownerToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-log-capture-owner' })).secretKey;
  await setFlag(false);
});

afterAll(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await removeSeeded([project]);
});

describe('a box without a journal: the capture writes fromV1 of the mirror', () => {
  test('v2 rows equal fromV1 of the stored v1 rows: seq, ids, block ids = part ids, residuals, ext; log_durable_at stays null', async () => {
    const session = await seedSession(project, OWNER);
    const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns: 6 });
    const firstUser = String(root.find((m) => m.info.role === 'user')!.info.id);
    await db.insert(sessionTurns).values({ turnToken: `turn-${session}`, sessionId: session, sandboxId: session, projectId: project.project_id, accountId: project.account_id, messageId: firstUser, state: 'ended' });
    await capture(session, root, [{ id: CHILD, payload: child }]);

    const log = await expectLogEqualsFromV1(session);
    expect(log.threads.map((t) => t.thread_id).sort()).toEqual([CHILD, ROOT].sort());
    // Every thread carries the kortix.transcript.v1 ext; block ids are the v1 part ids.
    for (const t of log.threads) expect(Object.values(t.ext ?? {}).map((e) => e.version)).toContain('kortix.transcript.v1');
    const rows = await liveRows(session);
    const mirror = await db.select({ id: sessionTranscriptMessages.messageId, parts: sessionTranscriptMessages.parts }).from(sessionTranscriptMessages).where(eq(sessionTranscriptMessages.sessionId, session));
    const withBlocks = rows.filter((r) => (r.record.blocks as unknown[]).length > 0 && mirror.some((m) => m.id === r.id));
    expect(withBlocks.length).toBeGreaterThan(0);
    for (const r of withBlocks) {
      const parts = mirror.find((m) => m.id === r.id)!.parts as Array<{ id: string }>;
      expect((r.record.blocks as Array<{ id: string }>).map((b) => b.id)).toEqual(parts.map((p) => p.id));
    }
    // Revs count from 1, one per message.
    expect(rows.map((r) => r.rev).sort((a, b) => a - b)).toEqual(rows.map((_, i) => i + 1));
    const [turn] = await db.select({ at: sessionTurns.logDurableAt }).from(sessionTurns).where(eq(sessionTurns.sessionId, session));
    expect(turn?.at).toBeNull();
    expect((await logRow(session))?.harnessCurrent).toBe('opencode');
  });

  test('an unchanged capture writes nothing; a new turn writes only its messages, at the next revs', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 4));
    const before = await logRows(session);
    await capture(session, range(0, 4));
    expect(await logRows(session)).toEqual(before);

    await capture(session, range(0, 6));
    const after = await logRows(session);
    expect(after.slice(0, 4)).toEqual(before);
    expect(after.slice(4).map((r) => [r.id, r.seq, r.rev])).toEqual([['msg_000004', 5, 5], ['msg_000005', 6, 6]]);
    await expectLogEqualsFromV1(session);
  });

  test('a changed v1 row (an edit) becomes a new revision of the same message', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 2));
    await capture(session, [plain(0), plain(1, 'reply 1, edited')]);
    const row = (await logRows(session)).find((r) => r.id === 'msg_000001')!;
    expect(row.rev).toBe(3);
    expect(JSON.stringify(row.record)).toContain('reply 1, edited');
    await expectLogEqualsFromV1(session);
  });

  test('the harness the daemon reported keys the log: pi', async () => {
    const session = await seedSession(project, OWNER);
    await db.insert(sessionRuntimeProjections).values({
      sessionId: session, projectId: project.project_id, accountId: project.account_id, externalId: session,
      harness: 'pi', projectionEtag: 'etag', projection: {}, source: 'push', capturedAt: new Date(),
    });
    await capture(session, range(0, 2));
    expect((await logRow(session))?.harnessCurrent).toBe('pi');
    await expectLogEqualsFromV1(session, 'pi');
  });

  test('a recorded rewind tombstones exactly the reverted ids; their seqs go to the messages after it', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 8));
    await setTranscriptRewindMarker(session, ROOT, 'msg_000004');
    // The next prompt commits the rewind: the box lists 0..3 and the replacement turn 8, 9.
    await capture(session, [...range(0, 4), plain(8), plain(9)]);

    const rows = await logRows(session);
    const dead = rows.filter((r) => r.deletedAt !== null);
    expect(dead.map((r) => r.id).sort()).toEqual(['msg_000004', 'msg_000005', 'msg_000006', 'msg_000007']);
    // A capture tombstone is a revision (rev 9..12: after the 8 first puts) at seq -rev.
    for (const r of dead) {
      expect(r.rev).toBeGreaterThan(8);
      expect(r.seq).toBe(-r.rev);
    }
    // The replacement turn takes the seqs fromV1 gives it, 5 and 6.
    expect((await liveRows(session)).map((r) => [r.id, r.seq])).toEqual([
      ['msg_000000', 1], ['msg_000001', 2], ['msg_000002', 3], ['msg_000003', 4], ['msg_000008', 5], ['msg_000009', 6],
    ]);
    await expectLogEqualsFromV1(session);
    // A shorter read afterwards (a box that lost its state) writes nothing.
    const settled = await logRows(session);
    await capture(session, range(0, 2));
    expect(await logRows(session)).toEqual(settled);
  });

  test('a 300 kB v1 text is offloaded like a journal text; content_hash stays the hash of the record as converted', async () => {
    const session = await seedSession(project, OWNER);
    // 300,000 bytes as UTF-8 in 100,000 characters: under the mirror's 200,000-character cut.
    const wide = '€'.repeat(100_000);
    await capture(session, [plain(0), plain(1, wide)]);
    const row = (await logRows(session)).find((r) => r.id === 'msg_000001')!;
    const block = (row.record.blocks as Array<{ text: string; ref?: string; bytes?: number }>)[0]!;
    expect(block.ref).toMatch(/^kortix-attachment:\/\//);
    expect(block.bytes).toBe(300_000);
    expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(16 * 1024);
    expect([...bucket.objects.keys()].filter((k) => k.startsWith(`${project.project_id}/${session}/`))).toHaveLength(1);
    const converted = (await fromMirror(session)).threads[0]!.messages.find((m) => m.message_id === 'msg_000001')!;
    expect(row.hash).toBe(sessionLogContentHash(converted));
  });

  test('the manifest lists capture rows as it lists journal rows', async () => {
    const session = await seedSession(project, OWNER);
    await db.insert(sessionSandboxes).values({ sandboxId: session, sessionId: session, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
    const box = (await createAccountToken({ accountId: project.account_id, userId: OWNER, projectId: project.project_id, sessionId: session, name: 'session-log-capture-box' })).secretKey;
    await capture(session, range(0, 4));
    const res = await app.request(`/v1/projects/${project.project_id}/sessions/${session}/log/manifest`, { headers: { Authorization: `Bearer ${box}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generation: number; messages: Array<{ message_id: string; content_hash: string; rev: number; deleted: boolean }> };
    expect(body.generation).toBe(0);
    expect(body.messages).toHaveLength(4);
    expect(body.messages).toEqual((await logRows(session)).map((r) => ({ message_id: r.id, content_hash: r.hash, rev: r.rev, deleted: false })));
  });

  test('with the flag on, the v1 window over a capture-written log equals the mirror', async () => {
    const session = await seedSession(project, OWNER);
    const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns: 50 });
    await capture(session, root, [{ id: CHILD, payload: child }]);
    const read = async (query: string) => {
      const res = await app.request(`/v1/projects/${project.project_id}/sessions/${session}/transcript?${query}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      expect(res.status).toBe(200);
      const { captured_at: capturedAt, ...body } = (await res.json()) as Record<string, unknown>;
      return { body, capturedAt };
    };
    const pages = async () => {
      const out: Array<{ body: Record<string, unknown>; capturedAt: unknown }> = [];
      let cursor: string | null = null;
      do {
        const page = await read(`shape=sync&limit=40${cursor ? `&before=${cursor}` : ''}`);
        out.push(page);
        cursor = page.body.next_cursor as string | null;
      } while (cursor);
      return [...out, await read(`shape=sync&child=${CHILD}`)];
    };
    const off = await pages();
    await setFlag(true);
    try {
      const on = await pages();
      expect(off.length).toBeGreaterThan(2);
      expect(on.map((p) => p.body)).toEqual(off.map((p) => p.body));
      // The log answered (its captured_at is the log's last write), not a mirror fallback.
      const [mirror] = await db.select({ at: sessionTranscriptMirrors.capturedAt }).from(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, session));
      expect(on[0]!.capturedAt).not.toBe(new Date(mirror!.at).toISOString());
    } finally {
      await setFlag(false);
    }
  });
});

describe('a box with a journal: journal rows always win', () => {
  test('capture first, then the journal: every journal put replaces its capture row, journal_seen_at is set, and the capture stops', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 4));
    expect((await logRows(session)).map((r) => r.rev)).toEqual([1, 2, 3, 4]);
    const outcome = await ingestSessionLogJournal(scope(session), journalOf(await fromMirror(session)));
    expect(outcome.status).toBe(200);
    expect((await logRow(session))?.journalSeenAt).toBeInstanceOf(Date);
    const journaled = await logRows(session);
    expect(journaled.every((r) => r.rev >= REV && (r.record.producer as { harness: string }).harness === 'opencode')).toBe(true);

    // A new turn on a box with a journal: the capture writes nothing.
    await capture(session, range(0, 6));
    expect(await logRows(session)).toEqual(journaled);
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(sessionLogMessages).where(and(eq(sessionLogMessages.sessionId, session), lt(sessionLogMessages.rev, LIMIT)))) as [{ n: number }];
    expect(n).toBe(0);
  });

  test('journal first, then the capture: nothing written; and by the rev rule alone a capture put never overwrites a journal row', async () => {
    const session = await seedSession(project, OWNER);
    // The mirror exists (an earlier capture of a box whose journal was not up yet), then the journal writes.
    await db.insert(sessionTranscriptMirrors).values({ sessionId: session, projectId: project.project_id, accountId: project.account_id, runtimeSessionId: ROOT, headComplete: true, capturedAt: new Date(), updatedAt: new Date() });
    await db.insert(sessionTranscriptMessages).values(range(0, 4).map((m) => ({ sessionId: session, messageId: String(m.info.id), runtimeSessionId: ROOT, role: String(m.info.role), info: m.info, parts: m.parts, capturedAt: new Date() })));
    const journal = journalOf(await fromMirror(session));
    for (const put of journal.puts) put.message.blocks = [{ type: 'text', id: `${put.message.message_id}-j`, text: 'journal' }];
    expect((await ingestSessionLogJournal(scope(session), journal)).status).toBe(200);
    const journaled = await logRows(session);

    await capture(session, [...range(0, 4).map((m) => ({ ...m, parts: [{ ...m.parts[0]!, text: 'capture edit' }] }))]);
    expect(await logRows(session)).toEqual(journaled);

    // Without the journal_seen_at gate, the (generation, rev) rule still keeps every journal row.
    await db.update(sessionLogs).set({ journalSeenAt: null }).where(eq(sessionLogs.sessionId, session));
    await capture(session, [...range(0, 4).map((m) => ({ ...m, parts: [{ ...m.parts[0]!, text: 'capture edit 2' }] }))]);
    const after = await logRows(session);
    for (const j of journaled) expect(after.find((r) => r.id === j.id)).toEqual(j);
  });

  test('a journal put that claims a capture row seq replaces that provisional row; two journal rows on one seq stay 422', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 4));
    expect((await logRows(session)).find((r) => r.seq === 2)).toMatchObject({ id: 'msg_000001', rev: 2 });
    // The daemon's own seq map put another message at seq 2 of the root thread.
    const other = { ...(await fromMirror(session)).threads[0]!.messages[1]!, message_id: 'msg_journal_only', seq: 2 };
    expect((await ingestSessionLogJournal(scope(session), { generation: 0, puts: [{ rev: REV, message: other }], tombstones: [], threads: [] })).status).toBe(200);
    const rows = await logRows(session);
    // The provisional row is tombstoned and moved to seq -rev, never deleted.
    expect(rows.find((r) => r.id === 'msg_000001')).toMatchObject({ seq: -2, rev: 2 });
    expect(rows.find((r) => r.id === 'msg_000001')?.deletedAt).not.toBeNull();
    expect(rows.find((r) => r.seq === 2)).toMatchObject({ id: 'msg_journal_only', rev: REV });

    const clash = await ingestSessionLogJournal(scope(session), { generation: 0, puts: [{ rev: REV + 1, message: { ...other, message_id: 'msg_journal_two' } }], tombstones: [], threads: [] });
    expect(clash.status).toBe(422);
    expect(clash.body).toMatchObject({ error: 'seq_conflict', message_id: 'msg_journal_two', seq: 2 });
  });
});

describe('a journal batch with no message does not claim the log', () => {
  const empty = (session?: SessionLogJournalRequest['session']): SessionLogJournalRequest => ({ generation: 0, session, threads: [], puts: [], tombstones: [] });

  test('a session patch or an empty batch leaves journal_seen_at null, and the capture still writes; a batch with a put sets it', async () => {
    const session = await seedSession(project, OWNER);
    // The daemon's boot patch, before any capture: it creates the log row.
    expect((await ingestSessionLogJournal(scope(session), empty({ restore_grade: 'native' }))).status).toBe(200);
    expect((await logRow(session))?.journalSeenAt).toBeNull();
    // The flush at stop with 0 messages, on an existing row.
    expect((await ingestSessionLogJournal(scope(session), empty())).status).toBe(200);
    expect((await ingestSessionLogJournal(scope(session), empty({ restore_grade: 'native' }))).status).toBe(200);
    expect((await logRow(session))?.journalSeenAt).toBeNull();

    await capture(session, range(0, 4));
    expect((await liveRows(session)).map((r) => r.id)).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000003']);
    await expectLogEqualsFromV1(session);

    const batch = journalOf(await fromMirror(session));
    expect((await ingestSessionLogJournal(scope(session), { ...batch, puts: batch.puts.slice(0, 1) })).status).toBe(200);
    expect((await logRow(session))?.journalSeenAt).toBeInstanceOf(Date);
  });

  test('a tombstone alone sets journal_seen_at', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 2));
    expect((await ingestSessionLogJournal(scope(session), { ...empty(), tombstones: [{ message_id: 'msg_000001', rev: REV }] })).status).toBe(200);
    expect((await logRow(session))?.journalSeenAt).toBeInstanceOf(Date);
  });
});

describe('the v1 window over a stale log', () => {
  const read = async (session: string, query = 'shape=sync&limit=40') => {
    const res = await app.request(`/v1/projects/${project.project_id}/sessions/${session}/transcript?${query}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** The mirror's content time: the newest row `captured_at`, which moves only when a row's info or parts change. */
  const mirrorAt = (session: string, at: Date) => db.update(sessionTranscriptMessages).set({ capturedAt: at }).where(eq(sessionTranscriptMessages.sessionId, session));
  const staleWarnings = (warn: { mock: { calls: unknown[][] } }, session: string) =>
    warn.mock.calls.filter((c) => String(c[0]).includes('log is behind the mirror') && (c[1] as { sessionId?: string })?.sessionId === session);

  test('a stop-style tail capture that changes no row, long after the last log write, leaves the log answering', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 6));
    // The last turn ended 5 minutes ago: the log's writes and the mirror's rows are that old.
    const old = new Date(Date.now() - 300_000);
    await db.update(sessionLogMessages).set({ updatedAt: old }).where(eq(sessionLogMessages.sessionId, session));
    await db.update(sessionLogs).set({ updatedAt: old }).where(eq(sessionLogs.sessionId, session));
    await mirrorAt(session, old);
    // The tail capture at stop: same history, so no row changes, but the mirror's capture time moves to now.
    await capture(session, range(0, 6));
    const [mirror] = await db.select({ at: sessionTranscriptMirrors.capturedAt }).from(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, session));
    expect(new Date(mirror!.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await setFlag(true);
    const warn = spyOn(logger, 'warn');
    try {
      const res = await read(session);
      expect(res.status).toBe(200);
      expect(res.body.captured_at).not.toBe(new Date(mirror!.at).toISOString());
      expect((res.body.messages as unknown[]).length).toBe(6);
      expect(staleWarnings(warn, session)).toHaveLength(0);
    } finally {
      warn.mockRestore();
      await setFlag(false);
    }
  });

  test('a mirror newer than the log by over 60 s serves the mirror and warns once per session; within 60 s the log answers', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 6));
    await setFlag(true);
    const warn = spyOn(logger, 'warn');
    try {
      const [{ last }] = (await db.select({ last: sql<Date>`max(${sessionLogMessages.updatedAt})` }).from(sessionLogMessages).where(eq(sessionLogMessages.sessionId, session))) as [{ last: Date }];
      const lastMs = new Date(last).getTime();
      // The mirror window's captured_at is the mirror's run time, whatever its rows' content time.
      const [mirror] = await db.select({ at: sessionTranscriptMirrors.capturedAt }).from(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, session));
      const mirrorIso = new Date(mirror!.at).toISOString();

      // Within the margin: the log answers (its captured_at is the log's last write).
      await mirrorAt(session, new Date(lastMs + 30_000));
      const near = await read(session);
      expect(near.status).toBe(200);
      expect(near.body.captured_at).not.toBe(mirrorIso);
      expect(staleWarnings(warn, session)).toHaveLength(0);

      // Over the margin (the rows' content time): the mirror answers, once-warned.
      const at = new Date(lastMs + 120_000);
      await mirrorAt(session, at);
      for (let i = 0; i < 2; i++) {
        const far = await read(session);
        expect(far.status).toBe(200);
        expect(far.body.captured_at).toBe(mirrorIso);
        expect((far.body.messages as unknown[]).length).toBe(6);
      }
      expect(staleWarnings(warn, session)).toHaveLength(1);
    } finally {
      warn.mockRestore();
      await setFlag(false);
    }
  });
});

describe('a cursor on a tombstoned message', () => {
  test('the v1 window over the log answers like the mirror: the unknown-cursor error, not an empty page', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 8));
    await setTranscriptRewindMarker(session, ROOT, 'msg_000004');
    await capture(session, [...range(0, 4), plain(8), plain(9)]);
    expect((await logRows(session)).filter((r) => r.deletedAt !== null).map((r) => r.id)).toContain('msg_000005');
    const read = async () => {
      const res = await app.request(`/v1/projects/${project.project_id}/sessions/${session}/transcript?shape=sync&limit=40&before=msg_000005`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      return { status: res.status, body: await res.json() };
    };
    const mirror = await read();
    expect(mirror.status).not.toBe(200);
    await setFlag(true);
    try {
      expect(await read()).toEqual(mirror);
    } finally {
      await setFlag(false);
    }
  });
});

describe('a converted log on a box that wakes with a journal (P3.3)', () => {
  const ROOT2 = 'ses_capturelogroot0000000002';
  const target = { provider: 'kortix', model: 'm' };
  const toolInput = (rows: Array<{ id: string; record: Record<string, unknown> }>, id = 'msg_000001') =>
    (rows.find((r) => r.id === id)?.record.blocks as Array<{ type: string; input?: unknown }>).find((b) => b.type === 'tool_call')?.input;
  /** A root history with one bash call. */
  const history = (): Msg[] => {
    const call = plain(1);
    call.parts.push({
      id: 'prt_1_bash', sessionID: ROOT, messageID: 'msg_000001', type: 'tool', callID: 'call_1', tool: 'bash',
      state: { status: 'completed', input: { command: 'ls', description: 'List files' }, output: 'a.txt', title: 'ls', metadata: { exit: 0, output: 'a.txt', description: 'List files' }, time: { start: 1, end: 2 } },
    });
    return [plain(0), call, plain(2), plain(3)];
  };
  /** A converted, `partial` log: the mirror row of the call in the old mirror's stripped shape (a settled call without `input`), then the converter. */
  const convertStripped = async (session: string, extra: Msg[] = []) => {
    await capture(session, [...history(), ...extra]);
    await db.execute(sql`UPDATE kortix.session_transcript_messages SET parts = parts #- '{1,state,input}' WHERE session_id = ${session} AND message_id = 'msg_000001'`);
    expect((await writeSessionLogFromMirror(session)).outcome).toBe('written');
    const log = await logRow(session);
    expect({ grade: log?.restoreGrade, counts: log?.gradeCounts }).toEqual({ grade: 'partial', counts: { tool_input: 1, cut_point: 0, attachment: 0 } });
    expect(toolInput(await liveRows(session))).toBeNull();
  };
  /** What a box's daemon exports: its native store, `restore_grade: 'native'` without `grade_counts`. */
  const nativeExport = (harness: 'opencode' | 'pi', rows: Msg[], root = ROOT): SessionLogJournalRequest => {
    const log = fromV1({ session_id: 'ignored', root_id: root, rows: rows.map((m) => ({ runtime_session_id: root, info: { ...m.info, sessionID: root }, parts: m.parts })) as unknown as V1Row[] }, { harness });
    const batch = journalOf(log);
    const { grade_counts: _counts, ...session } = { ...batch.session!, restore_grade: 'native' as const, harness: { current: harness, history: [] } };
    for (const put of batch.puts) put.message.producer = { harness, harness_version: '1', adapter_version: '1' };
    return { ...batch, session };
  };
  /** The log a batch describes, as `modelView` reads it. */
  const logOf = (batch: SessionLogJournalRequest): SessionLog =>
    ({ ...batch.session, session_id: 'ignored', threads: batch.threads.map((t) => ({ ...t, messages: batch.puts.map((p) => p.message).filter((m) => m.thread_id === t.thread_id) })) }) as unknown as SessionLog;
  /** The stored log as `modelView` reads it: the session record, the threads, the live rows in seq order. */
  const storedLog = async (session: string): Promise<SessionLog> => {
    const threads = await db.select({ id: sessionLogThreads.threadId, record: sessionLogThreads.record }).from(sessionLogThreads).where(eq(sessionLogThreads.sessionId, session));
    const rows = (await liveRows(session)).sort((a, b) => a.seq - b.seq);
    return { ...(await logRow(session))!.record, threads: threads.map((t) => ({ ...t.record, messages: rows.filter((r) => r.thread === t.id).map((r) => r.record) })) } as unknown as SessionLog;
  };
  const readLog = async (session: string) => {
    const res = await app.request(`/v1/projects/${project.project_id}/sessions/${session}/log?limit=500`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as { session: Record<string, unknown>; messages: Array<{ message_id: string; in_context: boolean; producer: { harness: string } }> };
  };
  /** Grade `native`, no `grade_counts` in the column or the record. */
  const expectNativeGrade = async (session: string) => {
    const row = await logRow(session);
    expect({ grade: row?.restoreGrade, counts: row?.gradeCounts ?? null, recordCounts: 'grade_counts' in (row?.record ?? {}) }).toEqual({ grade: 'native', counts: null, recordCounts: false });
    expect((await readLog(session)).session.restore_grade).toBe('native');
  };
  /** Capture rows: never hard-deleted. Live ones and their `in_context` (column and record). */
  const captureRows = async (session: string) => {
    const rows = await db
      .select({ id: sessionLogMessages.messageId, seq: sessionLogMessages.seq, rev: sessionLogMessages.rev, inContext: sessionLogMessages.inContext, deletedAt: sessionLogMessages.deletedAt, record: sessionLogMessages.record })
      .from(sessionLogMessages)
      .where(and(eq(sessionLogMessages.sessionId, session), lt(sessionLogMessages.rev, LIMIT)))
      .orderBy(asc(sessionLogMessages.messageId));
    for (const r of rows) expect(r.record.in_context).toBe(r.inContext);
    return rows;
  };

  test('OpenCode: the export replaces converted rows under the same ids; a row the store lacks stays visible, out of context; modelView equals the native view', async () => {
    const session = await seedSession(project, OWNER);
    // The mirror holds two messages the box no longer has.
    await convertStripped(session, [plain(4), plain(5)]);

    const batch = nativeExport('opencode', history());
    expect((await ingestSessionLogJournal(scope(session), batch)).status).toBe(200);

    await expectNativeGrade(session);
    const rows = await liveRows(session);
    expect(toolInput(rows)).toEqual({ command: 'ls', description: 'List files' });
    expect(rows.map((r) => [r.id, r.seq, r.rev >= REV])).toEqual([
      ['msg_000000', 1, true], ['msg_000001', 2, true], ['msg_000002', 3, true], ['msg_000003', 4, true], ['msg_000004', 5, false], ['msg_000005', 6, false],
    ]);
    expect((await captureRows(session)).map((r) => [r.id, r.inContext, r.deletedAt])).toEqual([['msg_000004', false, null], ['msg_000005', false, null]]);
    expect((await readLog(session)).messages.filter((m) => m.producer.harness === 'kortix-v1-import').map((m) => [m.message_id, m.in_context])).toEqual([['msg_000004', false], ['msg_000005', false]]);
    expect(modelView(await storedLog(session), target)).toEqual(modelView(logOf(batch), target));
  });

  test('a fresh box whose first journal batch is a prompt: every converted message stays visible (out of context) next to the new turn', async () => {
    const session = await seedSession(project, OWNER);
    await convertStripped(session);
    // A new box with an empty store: a new OpenCode root, and the boot export had no message.
    const batch = nativeExport('opencode', [plain(10), plain(11)], ROOT2);
    expect((await ingestSessionLogJournal(scope(session), batch)).status).toBe(200);

    await expectNativeGrade(session);
    expect((await liveRows(session)).map((r) => r.id).sort()).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000003', 'msg_000010', 'msg_000011']);
    expect((await captureRows(session)).every((r) => r.deletedAt === null && r.inContext === false)).toBe(true);
    const view = modelView(await storedLog(session), target);
    expect(view[ROOT2]).toEqual(modelView(logOf(batch), target)[ROOT2]!);
    expect(view[ROOT]).toEqual([]);
  });

  test('pi with a dump from before P2.5: `pi:` ids hide the converted duplicates of their thread (tombstones, never deletes); modelView equals the native view', async () => {
    const session = await seedSession(project, OWNER);
    await db.insert(sessionRuntimeProjections).values({
      sessionId: session, projectId: project.project_id, accountId: project.account_id, externalId: session,
      harness: 'pi', projectionEtag: 'etag', projection: {}, source: 'push', capturedAt: new Date(),
    });
    await convertStripped(session);

    // `pi:<entry id>` ids, seq = the entry position (gaps; 2 and 4 collide with converted seqs).
    const batch = nativeExport('pi', history());
    for (const [i, put] of batch.puts.entries()) {
      const id = `pi:e${i}`;
      put.message = { ...put.message, message_id: id, seq: 2 * (i + 1), blocks: put.message.blocks.map((b, j) => ({ ...b, id: `${id}-n${j}` })) };
    }
    expect((await ingestSessionLogJournal(scope(session), batch)).status).toBe(200);

    await expectNativeGrade(session);
    expect((await liveRows(session)).map((r) => r.id)).toEqual(['pi:e0', 'pi:e1', 'pi:e2', 'pi:e3']);
    expect(toolInput(await liveRows(session), 'pi:e1')).toEqual({ command: 'ls', description: 'List files' });
    const hidden = await captureRows(session);
    expect(hidden.map((r) => r.id).sort()).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000003']);
    for (const r of hidden) expect({ deleted: r.deletedAt !== null, seq: r.seq }).toEqual({ deleted: true, seq: -r.rev });
    expect(modelView(await storedLog(session), target)).toEqual(modelView(logOf(batch), target));
  });

  test('a split first export whose second batch never arrives hides nothing it did not replace', async () => {
    const session = await seedSession(project, OWNER);
    await convertStripped(session);
    const batch = nativeExport('opencode', history());
    expect((await ingestSessionLogJournal(scope(session), { ...batch, puts: batch.puts.slice(0, 2) })).status).toBe(200);

    const rows = await liveRows(session);
    expect(rows.map((r) => [r.id, r.rev >= REV, r.record.in_context])).toEqual([
      ['msg_000000', true, true], ['msg_000001', true, true], ['msg_000002', false, false], ['msg_000003', false, false],
    ]);
    expect((await logRows(session)).filter((r) => r.deletedAt !== null)).toEqual([]);
  });

  test('a first journal batch after a restore claim tombstones nothing and keeps the converted rows in context', async () => {
    const session = await seedSession(project, OWNER);
    await convertStripped(session);
    // A restored box journals under the claimed generation: its native store was written from this log.
    await claimSessionLog(scope(session));
    const restored = nativeExport('opencode', [...history(), plain(4)]);
    expect((await ingestSessionLogJournal(scope(session), { ...restored, generation: 1, puts: restored.puts.slice(-1) })).status).toBe(200);
    expect((await liveRows(session)).map((r) => r.id)).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000003', 'msg_000004']);
    expect((await captureRows(session)).every((r) => r.inContext && r.deletedAt === null)).toBe(true);
  });

  test('after a restore claim, a `pi:` reply (a restore writes them, e.g. a layout compaction) tombstones nothing', async () => {
    const session = await seedSession(project, OWNER);
    await convertStripped(session);
    await claimSessionLog(scope(session));
    const restored = nativeExport('pi', [...history(), plain(5)]);
    const reply = { ...restored.puts.at(-1)!.message, message_id: 'pi:layout1', seq: 6 };
    expect(reply.role).toBe('assistant');
    expect((await ingestSessionLogJournal(scope(session), { ...restored, generation: 1, puts: [{ rev: REV, message: reply }] })).status).toBe(200);
    expect((await liveRows(session)).map((r) => r.id)).toEqual(['msg_000000', 'msg_000001', 'msg_000002', 'msg_000003', 'pi:layout1']);
    expect((await captureRows(session)).every((r) => r.inContext && r.deletedAt === null)).toBe(true);
  });

  test('an identical re-put (a restarted daemon) is acknowledged and leaves the row; a changed put updates it; a capture row is always replaced', async () => {
    const session = await seedSession(project, OWNER);
    await capture(session, range(0, 2));
    // The capture row's own record, sent by the journal: the content hash is equal, the row is still replaced.
    const [first] = (await logRows(session)) as Array<{ record: Record<string, unknown> }>;
    const same = first!.record as unknown as SessionLogJournalRequest['puts'][number]['message'];
    expect((await ingestSessionLogJournal(scope(session), { generation: 0, threads: [], tombstones: [], puts: [{ rev: REV, message: same }] })).status).toBe(200);
    const replaced = (await db.select().from(sessionLogMessages).where(and(eq(sessionLogMessages.sessionId, session), eq(sessionLogMessages.messageId, 'msg_000000'))))[0]!;
    expect(replaced.rev).toBe(REV);

    const resend = await ingestSessionLogJournal(scope(session), { generation: 0, threads: [], tombstones: [], puts: [{ rev: REV + 10, message: same }] });
    expect(resend).toEqual({ status: 200, body: { acked: [{ message_id: 'msg_000000', rev: REV + 10 }] } });
    const kept = (await db.select().from(sessionLogMessages).where(and(eq(sessionLogMessages.sessionId, session), eq(sessionLogMessages.messageId, 'msg_000000'))))[0]!;
    expect({ rev: kept.rev, updatedAt: kept.updatedAt }).toEqual({ rev: REV, updatedAt: replaced.updatedAt });

    const changed = { ...same, blocks: [{ type: 'text', id: 'prt_0', text: 'edited' }] } as typeof same;
    expect((await ingestSessionLogJournal(scope(session), { generation: 0, threads: [], tombstones: [], puts: [{ rev: REV + 11, message: changed }] })).status).toBe(200);
    const updated = (await db.select().from(sessionLogMessages).where(and(eq(sessionLogMessages.sessionId, session), eq(sessionLogMessages.messageId, 'msg_000000'))))[0]!;
    expect(updated.rev).toBe(REV + 11);
  });

  test('a box that keeps an old daemon: the wake backfill reads the stripped calls again and the converter writes them to the log', async () => {
    const session = await seedSession(project, OWNER);
    await convertStripped(session);
    resetTranscriptBackfillMemoForTests();
    await backfillSessionTranscriptMirrorOnWake(session, {
      readMessages: async () => ({ opencodeSessionId: ROOT, payload: history(), headComplete: true, complete: true, children: [] }),
    });
    expect(toolInput(await liveRows(session))).toEqual({ command: 'ls', description: 'List files' });
    expect((await logRow(session))?.restoreGrade).toBe('converted');
    expect((await logRow(session))?.journalSeenAt).toBeNull();
  });
});
