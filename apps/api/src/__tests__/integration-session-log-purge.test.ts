/**
 * Integration test (real PostgreSQL, fresh migrated database): the retention
 * purge (P2.8, decision D6). A deleted session loses all its content 30 days
 * after the delete, in one tick. A session of a closed account (decision D6b: an
 * open `account_deletion_requests` row, closed at its `scheduled_for`) loses it
 * at day 80. The purge covers the v2 `session_log*` rows, the v1
 * `session_transcript_*` rows, the copies of the conversation in other tables
 * (model requests, prompt commands, voice turns, notifications, connector
 * results) and the `session-attachments` objects alike, and never touches a
 * live session. A deleted session's own row stays as a shell of ids and dates.
 *
 * The clock is the `now` argument of `purgeSessionContent`: every day below is
 * an offset from BASE, so no test sleeps. Real: every row, every query. Fake:
 * the Storage bucket (`helpers/fake-session-storage.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountDeletionRequests,
  connectorCalls,
  creditAccounts,
  gatewayRequestLogs,
  notifications,
  projectSessions,
  sessionContentPurges,
  sessionLifecycleCommands,
  sessionLogBlobs,
  sessionLogMessages,
  sessionLogs,
  sessionLogThreads,
  sessionTurns,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
  voiceCallTurns,
} from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { createSessionAttachmentStore } from '../projects/lib/session-attachments';
import { purgeSessionContent } from '../projects/session-log-purge';
import { restoreSession } from '../projects/session-lifecycle/restore-session';
import { db } from '../shared/db';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const DAY = 86_400_000;
const BASE = new Date('2026-06-01T00:00:00.000Z');
const day = (n: number) => new Date(BASE.getTime() + n * DAY);
const USER = crypto.randomUUID();

const bucket = fakeSessionStorage();
const store = createSessionAttachmentStore(bucket.storage as never);
const tick = (n: number, extra: Parameters<typeof purgeSessionContent>[0] = {}) =>
  purgeSessionContent({ now: day(n), store, ...extra });

const seeded: SeededProject[] = [];
const newProject = async (label: string, accountId?: string) => {
  const project = await seedProject(label, { accountId });
  seeded.push(project);
  return project;
};

/** One session with one row in every table the purge covers and one object. */
async function seedContent(project: SeededProject, opts: { deletedAt?: Date } = {}) {
  const sessionId = await seedSession(project, USER);
  // Created long before BASE: a session created after an account closure counts as used.
  await db
    .update(projectSessions)
    .set({ createdAt: day(-30), labels: ['synthetic'], error: 'synthetic error', metadata: { title: 'synthetic title', initial_prompt: 'synthetic prompt' } })
    .where(eq(projectSessions.sessionId, sessionId));
  if (opts.deletedAt) await markDeleted(sessionId, opts.deletedAt);
  const scope = { sessionId, projectId: project.project_id, accountId: project.account_id };
  const t = BASE;
  // A journal's log, as the box writes it: a restore leaves it alone (its
  // mirror conversion runs only for a log no journal owns).
  await db.insert(sessionLogs).values({ ...scope, v: 1, harnessCurrent: 'opencode', restoreGrade: 'A', record: {}, journalSeenAt: new Date() });
  await db.insert(sessionLogThreads).values({ sessionId, threadId: 'main', v: 1, record: {} });
  await db.insert(sessionLogMessages).values({
    sessionId, messageId: 'msg_1', threadId: 'main', seq: 0, role: 'user', kind: 'turn', inContext: true, createdAt: t,
    v: 1, producer: {}, generation: 0, rev: 1, contentHash: 'h', record: { blocks: [{ type: 'text', text: 'synthetic prompt' }] },
  });
  const object = `${project.project_id}/${sessionId}/00000000-0000-4000-8000-000000000001`;
  await db.insert(sessionLogBlobs).values({ sessionId, sha256: 'a'.repeat(64), objectKey: object, bytes: 3, mime: 'text/plain' });
  await db.insert(sessionTranscriptMirrors).values(scope);
  await db.insert(sessionTranscriptMessages).values({ sessionId, messageId: 'msg_1', role: 'user', info: {}, parts: [] });
  // Copies of the conversation outside the log.
  await db.insert(gatewayRequestLogs).values({
    requestId: crypto.randomUUID(), ...scope, requestedModel: 'm', resolvedModel: 'm', provider: 'p', status: 200, ok: true,
    request: { messages: [{ role: 'user', content: 'synthetic prompt' }] }, response: { value: 'synthetic answer' },
  });
  await db.insert(sessionLifecycleCommands).values({ ...scope, commandType: 'continue_session', source: 'test', payload: { text: 'synthetic prompt' } });
  await db.insert(voiceCallTurns).values({ sessionId, projectId: project.project_id, callId: 'call', role: 'user', text: 'synthetic' });
  await db.insert(notifications).values({ ...scope, userId: USER, kind: 'turn_done', title: 'synthetic', body: 'synthetic' });
  await db.insert(connectorCalls).values({ ...scope, actionPath: 'a.b', status: 'ok', resultSummary: { text: 'synthetic' } });
  bucket.objects.set(object, new Blob(['abc']));
  // An orphan the capture left behind: no blob row names it.
  bucket.objects.set(`${project.project_id}/${sessionId}/00000000-0000-4000-8000-000000000002`, new Blob(['orphan']));
  return { ...scope, object };
}

const markDeleted = (sessionId: string, at: Date) =>
  db.update(projectSessions).set({ metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ deletedAt: at.toISOString() })}::jsonb` }).where(eq(projectSessions.sessionId, sessionId));
const markUndeleted = (sessionId: string) =>
  db.update(projectSessions).set({ metadata: sql`metadata - 'deletedAt'` }).where(eq(projectSessions.sessionId, sessionId));

const count = async (table: typeof sessionLogs | typeof sessionLogThreads | typeof sessionLogMessages | typeof sessionLogBlobs | typeof sessionTranscriptMirrors | typeof sessionTranscriptMessages, sessionId: string) =>
  Number((await db.execute(sql`select count(*)::int as n from ${table} where session_id = ${sessionId}`))[0]!.n);
const rowsOf = async (sessionId: string) => ({
  logs: await count(sessionLogs, sessionId),
  threads: await count(sessionLogThreads, sessionId),
  messages: await count(sessionLogMessages, sessionId),
  blobs: await count(sessionLogBlobs, sessionId),
  mirrors: await count(sessionTranscriptMirrors, sessionId),
  v1: await count(sessionTranscriptMessages, sessionId),
  ...(await copiesOf(sessionId)),
});
/** The content of the copies: rows that billing or audit counts stay, without it. */
const copiesOf = async (sessionId: string) => {
  const [row] = await db.execute(sql`select
    (select count(*)::int from kortix.gateway_request_logs where session_id = ${sessionId} and (request is not null or response is not null)) as "modelBodies",
    (select count(*)::int from kortix.session_lifecycle_commands where session_id = ${sessionId} and payload <> '{}'::jsonb) as prompts,
    (select count(*)::int from kortix.voice_call_turns where session_id = ${sessionId}) as voice,
    (select count(*)::int from kortix.notifications where session_id = ${sessionId}) as notifications,
    (select count(*)::int from kortix.connector_calls where session_id::text = ${sessionId} and result_summary is not null) as "connectorResults"`);
  return row as { modelBodies: number; prompts: number; voice: number; notifications: number; connectorResults: number };
};
const COPIES = { modelBodies: 1, prompts: 1, voice: 1, notifications: 1, connectorResults: 1 };
const ALL = { logs: 1, threads: 1, messages: 1, blobs: 1, mirrors: 1, v1: 1, ...COPIES };
const NONE = { logs: 0, threads: 0, messages: 0, blobs: 0, mirrors: 0, v1: 0, modelBodies: 0, prompts: 0, voice: 0, notifications: 0, connectorResults: 0 };
const objectsOf = (c: { projectId: string; sessionId: string }) => [...bucket.objects.keys()].filter((k) => k.startsWith(`${c.projectId}/${c.sessionId}/`)).length;
const bookkeeping = async (sessionId: string) => (await db.select().from(sessionContentPurges).where(eq(sessionContentPurges.sessionId, sessionId)))[0];

// Every describe starts with an empty database: the purge reads every session, so a row a
// neighbour left behind would move the counts.
const cleanup = () => afterAll(async () => removeSeeded(seeded.splice(0)));

describe('a deleted session', () => {
  cleanup();
  let project: SeededProject;
  let c: Awaited<ReturnType<typeof seedContent>>;
  beforeAll(async () => {
    project = await newProject('purge-deleted');
    c = await seedContent(project, { deletedAt: day(0) });
  });

  test('day 29: nothing goes', async () => {
    expect(await tick(29)).toMatchObject({ sessions: 0, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(ALL);
    expect(objectsOf(c)).toBe(2);
    expect(await bookkeeping(c.sessionId)).toBeUndefined();
  });

  test('day 30: every row, every copy and every object goes in one tick, orphans included; one bookkeeping row says why and when', async () => {
    expect(await tick(30)).toMatchObject({ sessions: 1, objects: 1 });
    expect(await rowsOf(c.sessionId)).toEqual(NONE);
    expect(objectsOf(c)).toBe(0);
    const row = await bookkeeping(c.sessionId);
    expect(row).toMatchObject({ projectId: c.projectId, accountId: c.accountId, reason: 'session_deleted' });
    expect(row!.rowsPurgedAt).toEqual(day(30));
    expect(row!.objectsPurgedAt).toEqual(day(30));
  });

  test('day 30: the session row stays as a shell of ids and dates; the model request row stays for billing', async () => {
    const [shell] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, c.sessionId));
    expect(shell!.metadata).toEqual({ deletedAt: day(0).toISOString(), copiesPurgedAt: day(30).toISOString() });
    expect(shell!.labels).toEqual([]);
    expect(shell!.error).toBeNull();
    expect(await db.select().from(gatewayRequestLogs).where(eq(gatewayRequestLogs.sessionId, c.sessionId))).toHaveLength(1);
  });

  test('a second tick does nothing', async () => {
    const before = [...bucket.objects.keys()].length;
    expect(await tick(60)).toEqual({ sessions: 0, objects: 0, failed: 0, liveClosed: 0 });
    expect([...bucket.objects.keys()].length).toBe(before);
    expect((await bookkeeping(c.sessionId))!.objectsPurgedAt).toEqual(day(30));
  });
});

describe('a live or restored session', () => {
  cleanup();
  test('a session that was never deleted keeps everything at any age', async () => {
    const project = await newProject('purge-live');
    const c = await seedContent(project);
    expect(await tick(400)).toMatchObject({ sessions: 0, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(ALL);
    expect(objectsOf(c)).toBe(2);
  });

  test('a session un-deleted inside the window is skipped, and its objects stay', async () => {
    const project = await newProject('purge-undeleted');
    const c = await seedContent(project, { deletedAt: day(0) });
    await markUndeleted(c.sessionId);
    expect(await tick(45)).toMatchObject({ sessions: 0, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(ALL);
    expect(objectsOf(c)).toBe(2);
    expect(await bookkeeping(c.sessionId)).toBeUndefined();
  });

  test('a deleted session whose delete time is unreadable is skipped, and does not stop the others', async () => {
    const project = await newProject('purge-bad-deleted-at');
    const bad = await seedContent(project);
    await db.update(projectSessions).set({ metadata: { deletedAt: 'not a date' } }).where(eq(projectSessions.sessionId, bad.sessionId));
    const due = await seedContent(project, { deletedAt: day(0) });
    expect(await tick(30)).toMatchObject({ sessions: 1 });
    expect(await rowsOf(bad.sessionId)).toEqual(ALL);
    expect(await rowsOf(due.sessionId)).toEqual(NONE);
  });
});

describe('restoreSession and the purge', () => {
  cleanup();
  const restore = (c: { projectId: string; sessionId: string; accountId: string }, now: Date) =>
    restoreSession({ projectId: c.projectId, sessionId: c.sessionId, accountId: c.accountId, now });

  test('a session restored on day 29 keeps every row, copy and object past day 30', async () => {
    const project = await newProject('purge-restore-in-window');
    const c = await seedContent(project, { deletedAt: day(0) });
    expect(await restore(c, day(29))).toEqual({ ok: true });
    expect(await tick(45)).toMatchObject({ sessions: 0, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(ALL);
    expect(objectsOf(c)).toBe(2);
    expect(await bookkeeping(c.sessionId)).toBeUndefined();
  });

  test('after the day-30 purge a restore answers 410 at any clock, and the session stays deleted', async () => {
    const project = await newProject('purge-restore-too-late');
    const c = await seedContent(project, { deletedAt: day(0) });
    expect(await tick(30)).toMatchObject({ sessions: 1 });
    expect(await restore(c, day(30))).toMatchObject({ status: 410, code: 'session_purged' });
    // The done marker decides, not the caller's clock.
    expect(await restore(c, day(1))).toMatchObject({ status: 410, code: 'session_purged' });
    const [row] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(eq(projectSessions.sessionId, c.sessionId));
    expect((row!.metadata as Record<string, unknown>).deletedAt).toBe(day(0).toISOString());
  });
});

/** An account deletion request, as `request-deletion` writes it; the account is closed at `scheduledFor`. */
const requestClosure = async (accountId: string, scheduledFor: Date, status = 'pending', isCancelled = false) =>
  (await db.insert(accountDeletionRequests).values({ accountId, userId: USER, status, isCancelled, scheduledFor: scheduledFor.toISOString() }).returning())[0]!;
const cancelClosure = (id: string) =>
  db.update(accountDeletionRequests).set({ status: 'cancelled', cancelledAt: new Date().toISOString() }).where(eq(accountDeletionRequests.id, id));

describe('a closed account (D6b)', () => {
  cleanup();
  let project: SeededProject;
  let c: Awaited<ReturnType<typeof seedContent>>;
  beforeAll(async () => {
    project = await newProject('purge-closed');
    c = await seedContent(project);
    await requestClosure(project.account_id, day(0));
  });

  test('day 79: nothing goes', async () => {
    expect(await tick(79)).toMatchObject({ sessions: 0, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(ALL);
    expect(objectsOf(c)).toBe(2);
  });

  test('day 80: the rows, the copies and the objects go, inside 90 days; the session row keeps its metadata', async () => {
    expect(await tick(80)).toMatchObject({ sessions: 1, objects: 1 });
    expect(await rowsOf(c.sessionId)).toEqual(NONE);
    expect(objectsOf(c)).toBe(0);
    expect(await bookkeeping(c.sessionId)).toMatchObject({ reason: 'subscription_ended', objectsPurgedAt: day(80) });
    const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, c.sessionId));
    expect(row!.metadata).toMatchObject({ title: 'synthetic title' });
  });

  test('a second tick does nothing', async () => {
    expect(await tick(91)).toEqual({ sessions: 0, objects: 0, failed: 0, liveClosed: 0 });
  });

  test('the close is the end of the grace (scheduled_for), not the request; a stale `processing` claim counts too', async () => {
    const graced = await newProject('purge-closed-grace');
    const g = await seedContent(graced);
    await requestClosure(graced.account_id, day(14));
    const stuck = await newProject('purge-closed-processing');
    const p = await seedContent(stuck);
    await requestClosure(stuck.account_id, day(0), 'processing');
    expect(await tick(93.9)).toMatchObject({ sessions: 1 });
    expect(await rowsOf(g.sessionId)).toEqual(ALL);
    expect(await rowsOf(p.sessionId)).toEqual(NONE);
    expect(await tick(94)).toMatchObject({ sessions: 1 });
    expect(await rowsOf(g.sessionId)).toEqual(NONE);
  });

  test('an account with a session created after the close keeps ALL its sessions, and is counted as left for a person', async () => {
    const p = await newProject('purge-closed-new-session');
    await requestClosure(p.account_id, day(0));
    const old = await seedContent(p);
    const later = await seedContent(p);
    await db.update(projectSessions).set({ createdAt: day(20) }).where(eq(projectSessions.sessionId, later.sessionId));
    expect(await tick(90)).toMatchObject({ sessions: 0, liveClosed: 1 });
    expect(await rowsOf(old.sessionId)).toEqual(ALL);
    expect(objectsOf(old)).toBe(2);
    expect(await rowsOf(later.sessionId)).toEqual(ALL);
  });

  test('an account with a turn after the close on one session keeps every session', async () => {
    const p = await newProject('purge-closed-turn');
    await requestClosure(p.account_id, day(0));
    const withTurn = await seedContent(p);
    const idle = await seedContent(p);
    await db.insert(sessionTurns).values({ turnToken: crypto.randomUUID(), sessionId: withTurn.sessionId, sandboxId: crypto.randomUUID(), projectId: p.project_id, accountId: p.account_id, startedAt: day(10) });
    expect(await tick(90)).toMatchObject({ sessions: 0, liveClosed: 2 });
    expect(await rowsOf(withTurn.sessionId)).toEqual(ALL);
    expect(await rowsOf(idle.sessionId)).toEqual(ALL);
  });

  test('a closed account on a paid tier whose payment is live is never purged; a cancelled payment does not save it', async () => {
    const paid = await newProject('purge-closed-paid');
    await db.insert(creditAccounts).values({ accountId: paid.account_id, tier: 'tier_25_200', paymentStatus: 'active', stripeSubscriptionStatus: 'active' });
    await requestClosure(paid.account_id, day(0));
    const kept = await seedContent(paid);
    const lapsed = await newProject('purge-closed-paid-cancelled');
    await db.insert(creditAccounts).values({ accountId: lapsed.account_id, tier: 'tier_25_200', paymentStatus: 'deleted', stripeSubscriptionStatus: 'canceled' });
    await requestClosure(lapsed.account_id, day(0));
    const gone = await seedContent(lapsed);
    expect(await tick(300)).toMatchObject({ sessions: 1, liveClosed: 3 });
    expect(await rowsOf(kept.sessionId)).toEqual(ALL);
    expect(await rowsOf(gone.sessionId)).toEqual(NONE);
  });

  test('two open requests: the earliest scheduled_for is the close', async () => {
    const p = await newProject('purge-closed-two');
    const s = await seedContent(p);
    await requestClosure(p.account_id, day(10), 'processing');
    await requestClosure(p.account_id, day(0));
    expect(await tick(79.9)).toMatchObject({ sessions: 0 });
    expect(await tick(80)).toMatchObject({ sessions: 1 });
    expect(await rowsOf(s.sessionId)).toEqual(NONE);
  });

  test('a deleted session of a closed account is purged by whichever window comes first', async () => {
    const p = await newProject('purge-both');
    await requestClosure(p.account_id, day(0));
    const s = await seedContent(p, { deletedAt: day(70) });
    // Delete window: day 100. Closure window: day 80.
    expect(await tick(80)).toMatchObject({ sessions: 1 });
    expect(await bookkeeping(s.sessionId)).toMatchObject({ reason: 'subscription_ended' });
    expect(await rowsOf(s.sessionId)).toEqual(NONE);
  });
});

describe('an account that is not closed', () => {
  cleanup();
  const setBilling = (accountId: string, values: { stripeSubscriptionStatus: string | null; paymentStatus?: string; tier?: string }) =>
    db.insert(creditAccounts).values({ accountId, ...values }).onConflictDoUpdate({ target: creditAccounts.accountId, set: values });

  test('plan cancellation, a downgrade to free, a failed payment, an unpaid subscription: never purged', async () => {
    const cases = [
      { stripeSubscriptionStatus: 'canceled', paymentStatus: 'cancelling' },
      { stripeSubscriptionStatus: 'canceled', tier: 'free' },
      { stripeSubscriptionStatus: 'past_due', paymentStatus: 'past_due' },
      { stripeSubscriptionStatus: 'unpaid', paymentStatus: 'past_due' },
      { stripeSubscriptionStatus: 'incomplete_expired' },
      { stripeSubscriptionStatus: null },
    ];
    const sessions = [];
    for (const [i, billing] of cases.entries()) {
      const p = await newProject(`purge-open-${i}`);
      await setBilling(p.account_id, billing);
      sessions.push(await seedContent(p));
    }
    const none = await seedContent(await newProject('purge-open-no-billing'));
    for (const n of [0, 80, 87, 400]) expect(await tick(n)).toEqual({ sessions: 0, objects: 0, failed: 0, liveClosed: 0 });
    for (const s of [...sessions, none]) {
      expect(await rowsOf(s.sessionId)).toEqual(ALL);
      expect(objectsOf(s)).toBe(2);
      expect(await bookkeeping(s.sessionId)).toBeUndefined();
    }
  });

  test('a completed request, and a legacy pending row with is_cancelled set, never count as closing', async () => {
    const done = await newProject('purge-completed');
    const a = await seedContent(done);
    await requestClosure(done.account_id, day(0), 'completed');
    const legacy = await newProject('purge-legacy-cancelled');
    const b = await seedContent(legacy);
    await requestClosure(legacy.account_id, day(0), 'pending', true);
    expect(await tick(300)).toMatchObject({ sessions: 0, objects: 0, liveClosed: 0 });
    expect(await rowsOf(a.sessionId)).toEqual(ALL);
    expect(await rowsOf(b.sessionId)).toEqual(ALL);
  });

  test('a closure cancelled while its objects removal fails still loses its objects, then its marker', async () => {
    const p = await newProject('purge-cancel-between');
    const s = await seedContent(p);
    const req = await requestClosure(p.account_id, day(0));
    const failing = { removeSession: async () => { throw new Error('storage down'); } };
    expect(await tick(80, { store: failing })).toMatchObject({ sessions: 1, objects: 0, failed: 1 });
    await cancelClosure(req.id);
    expect(await bookkeeping(s.sessionId)).toMatchObject({ reason: 'subscription_ended', objectsPurgedAt: null });
    expect(await tick(81)).toMatchObject({ objects: 1 });
    expect(objectsOf(s)).toBe(0);
    await tick(82);
    expect(await bookkeeping(s.sessionId)).toBeUndefined();
    expect(await rowsOf(s.sessionId)).toEqual(NONE);
  });

  test('a cancelled closure keeps everything', async () => {
    const p = await newProject('purge-cancelled-closure');
    const s = await seedContent(p);
    await cancelClosure((await requestClosure(p.account_id, day(0))).id);
    expect(await tick(300)).toMatchObject({ sessions: 0, objects: 0 });
    expect(await rowsOf(s.sessionId)).toEqual(ALL);
    expect(objectsOf(s)).toBe(2);
  });

  test('an account reopened after a purge: its markers go, a reused session is purged again after a new close, objects written later too', async () => {
    const p = await newProject('purge-reopened');
    const s = await seedContent(p);
    const first = await requestClosure(p.account_id, day(0));
    await tick(80);
    expect(await rowsOf(s.sessionId)).toEqual(NONE);
    expect(objectsOf(s)).toBe(0);
    await cancelClosure(first.id);
    await tick(100);
    expect(await bookkeeping(s.sessionId)).toBeUndefined();
    // The session is reused: new rows and a new object.
    await db.insert(sessionLogs).values({ sessionId: s.sessionId, projectId: s.projectId, accountId: s.accountId, v: 1, harnessCurrent: 'opencode', restoreGrade: 'A', record: {} });
    bucket.objects.set(`${s.projectId}/${s.sessionId}/00000000-0000-4000-8000-000000000003`, new Blob(['late']));
    await tick(150);
    expect(await count(sessionLogs, s.sessionId)).toBe(1);
    // It closes again: a new date, a new 80 days.
    await requestClosure(p.account_id, day(151));
    expect(await tick(230)).toMatchObject({ sessions: 0 });
    expect(await tick(231)).toMatchObject({ sessions: 1, objects: 1 });
    expect(await count(sessionLogs, s.sessionId)).toBe(0);
    expect(objectsOf(s)).toBe(0);
  });
});

describe('the tick is bounded and survives a failing store', () => {
  cleanup();
  test('a batch of 2 purges the 2 oldest deletes first, then the rest; a second pass is empty', async () => {
    const project = await newProject('purge-batch');
    const sessions: Array<{ i: number; sessionId: string }> = [];
    for (const [i, d] of [[0, 300], [1, 100], [2, 200], [3, 150], [4, 120]] as const) sessions.push({ i, ...(await seedContent(project, { deletedAt: day(d - 400) })) });
    const purged = async () => (await db.select({ id: sessionContentPurges.sessionId }).from(sessionContentPurges).where(inArray(sessionContentPurges.sessionId, sessions.map((s) => s.sessionId)))).map((r) => r.id);
    const idOf = (...is: number[]) => is.map((i) => sessions.find((s) => s.i === i)!.sessionId).sort();
    expect(await tick(0, { batchSize: 2 })).toMatchObject({ sessions: 2 });
    // Oldest deletedAt first: offsets 100-400, 120-400, 150-400, 200-400, 300-400 -> sessions 1, 4, 3, 2, 0.
    expect((await purged()).sort()).toEqual(idOf(1, 4));
    expect(await tick(0, { batchSize: 2 })).toMatchObject({ sessions: 2 });
    expect((await purged()).sort()).toEqual(idOf(1, 4, 3, 2));
    expect(await tick(0, { batchSize: 2 })).toMatchObject({ sessions: 1 });
    expect(await tick(0, { batchSize: 2 })).toMatchObject({ sessions: 0 });
  });

  test('a store that fails leaves the session due, and the next tick retries it', async () => {
    const project = await newProject('purge-store-fails');
    const c = await seedContent(project, { deletedAt: day(0) });
    const failing = { removeSession: async () => { throw new Error('storage down'); } };
    expect(await tick(30, { store: failing })).toMatchObject({ sessions: 1, objects: 0, failed: 1 });
    expect((await bookkeeping(c.sessionId))!.objectsPurgedAt).toBeNull();
    expect(objectsOf(c)).toBe(2);
    expect(await tick(41)).toMatchObject({ objects: 1, failed: 0 });
    expect(objectsOf(c)).toBe(0);
  });

  test('a session whose rows cannot be deleted counts as failed, stays due, and does not stop the others', async () => {
    const project = await newProject('purge-rows-fail');
    const broken = await seedContent(project, { deletedAt: day(-200) });
    const fine = await seedContent(project, { deletedAt: day(-100) });
    // A trigger that refuses to delete this one session's thread row, as a locked or corrupt row would.
    await db.execute(sql.raw(`create or replace function kortix.purge_test_refuse() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`));
    await db.execute(sql.raw(`create trigger purge_test_refuse before delete on kortix.session_log_threads for each row when (old.session_id = '${broken.sessionId}') execute function kortix.purge_test_refuse()`));
    try {
      expect(await tick(0)).toMatchObject({ sessions: 1, failed: 1 });
      expect(await rowsOf(broken.sessionId)).toEqual(ALL);
      expect(await bookkeeping(broken.sessionId)).toBeUndefined();
      expect(await rowsOf(fine.sessionId)).toEqual(NONE);
    } finally {
      await db.execute(sql.raw('drop trigger purge_test_refuse on kortix.session_log_threads'));
      await db.execute(sql.raw('drop function kortix.purge_test_refuse()'));
    }
    expect(await tick(0)).toMatchObject({ sessions: 1, failed: 0 });
    expect(await rowsOf(broken.sessionId)).toEqual(NONE);
  });

  test('an object of a live session outside any purged folder stays', async () => {
    const project = await newProject('purge-neighbour');
    const gone = await seedContent(project, { deletedAt: day(0) });
    const kept = await seedContent(project);
    await tick(30);
    expect(objectsOf(gone)).toBe(0);
    expect(objectsOf(kept)).toBe(2);
  });
});

/**
 * Every table that names a session, and what the purge does with it. A new table
 * fails here until it is classified: a table that copies session content must be
 * purged or scrubbed in `purgeRows`, or the "gone after 30 days" promise breaks.
 */
const SESSION_TABLES: Record<string, 'purged' | 'scrubbed' | `kept: ${string}`> = {
  'session_logs.session_id': 'purged',
  'session_log_threads.session_id': 'purged',
  'session_log_messages.session_id': 'purged',
  'session_log_blobs.session_id': 'purged',
  'session_transcript_messages.session_id': 'purged',
  'session_transcript_mirrors.session_id': 'purged',
  'voice_call_turns.session_id': 'purged',
  'session_pending_questions.session_id': 'purged',
  'session_runtime_projections.session_id': 'purged',
  'project_session_runtime_contexts.session_id': 'purged',
  'chat_turn_streams.session_id': 'purged',
  'project_session_public_shares.session_id': 'purged',
  'notifications.session_id': 'purged',
  'gateway_request_logs.session_id': 'scrubbed',
  'connector_calls.session_id': 'scrubbed',
  'session_lifecycle_commands.session_id': 'scrubbed',
  'project_sessions.session_id': 'scrubbed',
  'project_sessions.parent_session_id': 'kept: an id',
  'session_content_purges.session_id': 'kept: the done marker',
  'usage_events.session_id': 'kept: billing',
  'sandbox_compute_sessions.session_id': 'kept: billing',
  'session_turns.session_id': 'kept: metering, no content',
  'audit_events.session_id': 'kept: audit trail',
  'audit_events_legacy.session_id': 'kept: audit trail',
  'audit_session_sequences.session_id': 'kept: audit trail',
  'tunnel_audit_logs.session_id': 'kept: audit trail',
  'provider_events.session_id': 'kept: provider operations, no content',
  'session_sandboxes.session_id': 'kept: the box record, no content',
  'account_session_activity.session_id': 'kept: a login session, not a project session',
  'account_tokens.session_id': 'kept: token metadata, no content',
  'connection_oauth_sessions.session_id': 'kept: an OAuth flow, no content',
  'app_deployments.source_session_id': 'kept: the App outlives the session',
  'change_requests.origin_session_id': 'kept: the change request outlives the session',
  'review_items.origin_session_id': 'kept: the review outlives the session',
  'project_trigger_executions.session_id': 'kept: the trigger outlives the session',
  'project_trigger_runtime.session_id': 'kept: the trigger outlives the session',
  'project_monitor_events.session_id': 'kept: the monitor has its own retention',
  'config_release_failures.session_id': 'kept: ids and a reason code',
  'connector_attachments.session_id': 'kept: expires on its own (cleanupExpiredConnectorAttachments)',
  'legacy_sandbox_migrations.session_id': 'kept: migration bookkeeping',
  'chat_threads.session_id': 'kept: ids only',
  'chat_thread_participants.session_id': 'kept: ids only',
  'room_members.session_id': 'kept: ids only',
  'notification_watchers.session_id': 'kept: ids only',
  'permission_push_claims.session_id': 'kept: ids only',
  'session_presence_leases.session_id': 'kept: ids only, expires',
  'project_session_user_states.session_id': 'kept: pin and archive dates only',
  'project_session_connector_bindings.session_id': 'kept: ids only',
  'project_session_grants.session_id': 'kept: ids only',
  'project_session_secret_handles.session_id': 'kept: secret names, no values',
  'session_provider_secret_pools.session_id': 'kept: secret ids, no values',
  'session_user_provider_connections.session_id': 'kept: ids only',
  'session_tool_approvals.session_id': 'kept: an action path, no content',
  'memory_thread_loads.session_id': 'kept: memory layer and page ids, no content',
  'project_space_links.session_id': 'kept: a channel link outlives the thread that shared it',
};

test('every table that names a session is classified for the purge', async () => {
  const rows = await db.execute(sql`
    select c.relname || '.' || a.attname as col
    from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'kortix' and c.relkind in ('r', 'p') and not c.relispartition and not a.attisdropped
      and a.attname in ('session_id', 'source_session_id', 'origin_session_id', 'parent_session_id')`);
  expect((rows as unknown as { col: string }[]).map((r) => r.col).sort()).toEqual(Object.keys(SESSION_TABLES).sort());
});

describe('a deleted session purged before the copies were covered', () => {
  cleanup();
  test('the next tick scrubs its copies and shells its row, and keeps the first purge date', async () => {
    const project = await newProject('purge-backlog');
    const c = await seedContent(project, { deletedAt: day(0) });
    // The old purge: the log rows gone and the marker written, the copies and the metadata left.
    await db.delete(sessionLogMessages).where(eq(sessionLogMessages.sessionId, c.sessionId));
    await db.insert(sessionContentPurges).values({ sessionId: c.sessionId, projectId: c.projectId, accountId: c.accountId, reason: 'session_deleted', rowsPurgedAt: day(30), objectsPurgedAt: day(37) });
    expect(await tick(100)).toMatchObject({ sessions: 1, failed: 0 });
    expect(await copiesOf(c.sessionId)).toEqual({ modelBodies: 0, prompts: 0, voice: 0, notifications: 0, connectorResults: 0 });
    const [row] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(eq(projectSessions.sessionId, c.sessionId));
    expect(row!.metadata).toEqual({ deletedAt: day(0).toISOString(), copiesPurgedAt: day(100).toISOString() });
    expect((await bookkeeping(c.sessionId))!.rowsPurgedAt).toEqual(day(30));
    expect(await tick(101)).toMatchObject({ sessions: 0 });
  });
});
