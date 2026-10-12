/**
 * Integration test (real PostgreSQL, fresh migrated database): the retention
 * purge (P2.8, decision D6). A deleted session loses its rows 30 days after the
 * delete and its objects 7 days after the rows. A session of an account whose
 * subscription ended loses its rows at day 80 and its objects at day 87. The
 * purge covers the v2 `session_log*` rows, the v1 `session_transcript_*` rows
 * and the `session-attachments` objects alike, and never touches a live session.
 *
 * The clock is the `now` argument of `purgeSessionContent`: every day below is
 * an offset from BASE, so no test sleeps. Real: every row, every query. Fake:
 * the Storage bucket (`helpers/fake-session-storage.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountSubscriptionEnds,
  creditAccounts,
  projectSessions,
  sessionContentPurges,
  sessionLogBlobs,
  sessionLogMessages,
  sessionLogs,
  sessionLogThreads,
  sessionTurns,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { createSessionAttachmentStore } from '../projects/lib/session-attachments';
import { purgeSessionContent } from '../projects/session-log-purge';
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
  // Created long before BASE: a session created after a subscription end counts as used.
  await db.update(projectSessions).set({ createdAt: day(-30) }).where(eq(projectSessions.sessionId, sessionId));
  if (opts.deletedAt) await markDeleted(sessionId, opts.deletedAt);
  const scope = { sessionId, projectId: project.project_id, accountId: project.account_id };
  const t = BASE;
  await db.insert(sessionLogs).values({ ...scope, v: 1, harnessCurrent: 'opencode', restoreGrade: 'A', record: {} });
  await db.insert(sessionLogThreads).values({ sessionId, threadId: 'main', v: 1, record: {} });
  await db.insert(sessionLogMessages).values({
    sessionId, messageId: 'msg_1', threadId: 'main', seq: 0, role: 'user', kind: 'turn', inContext: true, createdAt: t,
    v: 1, producer: {}, generation: 0, rev: 1, contentHash: 'h', record: { blocks: [{ type: 'text', text: 'synthetic prompt' }] },
  });
  const object = `${project.project_id}/${sessionId}/00000000-0000-4000-8000-000000000001`;
  await db.insert(sessionLogBlobs).values({ sessionId, sha256: 'a'.repeat(64), objectKey: object, bytes: 3, mime: 'text/plain' });
  await db.insert(sessionTranscriptMirrors).values(scope);
  await db.insert(sessionTranscriptMessages).values({ sessionId, messageId: 'msg_1', role: 'user', info: {}, parts: [] });
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
});
const ALL = { logs: 1, threads: 1, messages: 1, blobs: 1, mirrors: 1, v1: 1 };
const NONE = { logs: 0, threads: 0, messages: 0, blobs: 0, mirrors: 0, v1: 0 };
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

  test('day 30: every row goes, both stores, the objects stay, one bookkeeping row says why and when', async () => {
    expect(await tick(30)).toMatchObject({ sessions: 1, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(NONE);
    expect(objectsOf(c)).toBe(2);
    const row = await bookkeeping(c.sessionId);
    expect(row).toMatchObject({ projectId: c.projectId, accountId: c.accountId, reason: 'session_deleted', objectsPurgedAt: null });
    expect(row!.rowsPurgedAt).toEqual(day(30));
  });

  test('day 36: the objects are still there; the session row itself stays', async () => {
    expect(await tick(36.9)).toMatchObject({ sessions: 0, objects: 0 });
    expect(objectsOf(c)).toBe(2);
    expect(await db.select().from(projectSessions).where(eq(projectSessions.sessionId, c.sessionId))).toHaveLength(1);
  });

  test('day 37: every object under the session folder goes, orphans included; a second tick does nothing', async () => {
    expect(await tick(37)).toMatchObject({ sessions: 0, objects: 1 });
    expect(objectsOf(c)).toBe(0);
    expect((await bookkeeping(c.sessionId))!.objectsPurgedAt).toEqual(day(37));
    const before = [...bucket.objects.keys()].length;
    expect(await tick(60)).toEqual({ sessions: 0, objects: 0, failed: 0 });
    expect([...bucket.objects.keys()].length).toBe(before);
    expect((await bookkeeping(c.sessionId))!.objectsPurgedAt).toEqual(day(37));
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

describe('an account whose subscription ended', () => {
  cleanup();
  const setStatus = (accountId: string, status: string | null) =>
    db.insert(creditAccounts).values({ accountId, stripeSubscriptionStatus: status }).onConflictDoUpdate({ target: creditAccounts.accountId, set: { stripeSubscriptionStatus: status } });
  let project: SeededProject;
  let c: Awaited<ReturnType<typeof seedContent>>;
  beforeAll(async () => {
    project = await newProject('purge-ended');
    c = await seedContent(project);
    await setStatus(project.account_id, 'canceled');
  });

  test('the first tick dates the end at its own time and purges nothing', async () => {
    expect(await tick(0)).toMatchObject({ sessions: 0, objects: 0 });
    const [mark] = await db.select().from(accountSubscriptionEnds).where(eq(accountSubscriptionEnds.accountId, project.account_id));
    expect(mark!.endedAt).toEqual(day(0));
    // A later tick does not move the date.
    await tick(5);
    const [again] = await db.select().from(accountSubscriptionEnds).where(eq(accountSubscriptionEnds.accountId, project.account_id));
    expect(again!.endedAt).toEqual(day(0));
  });

  test('day 79: nothing goes', async () => {
    expect(await tick(79)).toMatchObject({ sessions: 0, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(ALL);
  });

  test('day 80: the rows go, the objects stay', async () => {
    expect(await tick(80)).toMatchObject({ sessions: 1, objects: 0 });
    expect(await rowsOf(c.sessionId)).toEqual(NONE);
    expect(objectsOf(c)).toBe(2);
    expect(await bookkeeping(c.sessionId)).toMatchObject({ reason: 'subscription_ended', objectsPurgedAt: null });
  });

  test('day 86: the objects stay; day 87: they go, and the purge is finished by day 87', async () => {
    await tick(86.9);
    expect(objectsOf(c)).toBe(2);
    expect(await tick(87)).toMatchObject({ objects: 1 });
    expect(objectsOf(c)).toBe(0);
  });

  test('a session used after the end is skipped: a turn that started after it, or a session created after it', async () => {
    const p = await newProject('purge-ended-used');
    await setStatus(p.account_id, 'canceled');
    const withTurn = await seedContent(p);
    const created = await seedContent(p);
    const idle = await seedContent(p);
    await tick(0);
    await db.insert(sessionTurns).values({ turnToken: crypto.randomUUID(), sessionId: withTurn.sessionId, sandboxId: crypto.randomUUID(), projectId: p.project_id, accountId: p.account_id, startedAt: day(10) });
    await db.update(projectSessions).set({ createdAt: day(20) }).where(eq(projectSessions.sessionId, created.sessionId));
    expect(await tick(90)).toMatchObject({ sessions: 1 });
    expect(await rowsOf(withTurn.sessionId)).toEqual(ALL);
    expect(await rowsOf(created.sessionId)).toEqual(ALL);
    expect(await rowsOf(idle.sessionId)).toEqual(NONE);
  });

  test('an account whose subscription is live again before day 80 loses nothing, and its end is forgotten', async () => {
    const p = await newProject('purge-resubscribed');
    await setStatus(p.account_id, 'canceled');
    const s = await seedContent(p);
    await tick(0);
    await setStatus(p.account_id, 'active');
    expect(await tick(79)).toMatchObject({ sessions: 0 });
    expect(await db.select().from(accountSubscriptionEnds).where(eq(accountSubscriptionEnds.accountId, p.account_id))).toHaveLength(0);
    expect(await tick(120)).toMatchObject({ sessions: 0 });
    expect(await rowsOf(s.sessionId)).toEqual(ALL);
  });

  test('an account with no subscription record, and a live one, are never purged', async () => {
    const none = await newProject('purge-no-sub');
    const live = await newProject('purge-live-sub');
    await setStatus(live.account_id, 'active');
    const a = await seedContent(none);
    const b = await seedContent(live);
    await tick(0);
    expect(await tick(300)).toMatchObject({ sessions: 0 });
    expect(await rowsOf(a.sessionId)).toEqual(ALL);
    expect(await rowsOf(b.sessionId)).toEqual(ALL);
  });

  test('a deleted session of an ended account is purged by whichever window comes first', async () => {
    const p = await newProject('purge-both');
    await setStatus(p.account_id, 'canceled');
    const s = await seedContent(p, { deletedAt: day(70) });
    await tick(0);
    // Delete window: day 100. Subscription window: day 80.
    expect(await tick(80)).toMatchObject({ sessions: 1 });
    expect(await bookkeeping(s.sessionId)).toMatchObject({ reason: 'subscription_ended' });
    expect(await rowsOf(s.sessionId)).toEqual(NONE);
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
    await tick(30);
    const failing = { removeSession: async () => { throw new Error('storage down'); } };
    expect(await tick(40, { store: failing })).toMatchObject({ objects: 0, failed: 1 });
    expect((await bookkeeping(c.sessionId))!.objectsPurgedAt).toBeNull();
    expect(objectsOf(c)).toBe(2);
    expect(await tick(41)).toMatchObject({ objects: 1, failed: 0 });
    expect(objectsOf(c)).toBe(0);
  });

  test('an object of a live session outside any purged folder stays', async () => {
    const project = await newProject('purge-neighbour');
    const gone = await seedContent(project, { deletedAt: day(0) });
    const kept = await seedContent(project);
    await tick(30);
    await tick(37);
    expect(objectsOf(gone)).toBe(0);
    expect(objectsOf(kept)).toBe(2);
  });
});
