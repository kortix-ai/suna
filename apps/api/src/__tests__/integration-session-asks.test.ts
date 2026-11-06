/**
 * Integration test (real local PostgreSQL): the session ask ledger
 * (projects/lib/session-asks.ts, pending-permissions.ts, pending-questions.ts).
 *
 * An ask never holds its session: the runtime parks it, and the stored row is
 * what waits for a person. These rows pin what the routes and the inbox rely on:
 * - a parked (parkable) question outlives the turn end and a later prompt;
 * - a permission approval given while the call was parked is consumed by
 *   exactly one re-run of the same call, and a denial by none;
 * - an expired ask waits on nobody;
 * - a hidden worker's ask shows on the root session a person opens.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { projectSessions, sessionPendingPermissions } from '@kortix/db';
import { eq } from 'drizzle-orm';

const { db } = await import('../shared/db');
const { clearOpenQuestions, recordPendingQuestion } = await import('../projects/lib/pending-questions');
const { decidePendingPermission, recordPendingPermission, takeApprovedCall } = await import('../projects/lib/pending-permissions');
const { askExpiresAt, listOpenAsks, liveWaitMsFor, ASK_LIVE_WAIT_MS, sessionHasLiveAsk, surfaceSessionIdOf } = await import('../projects/lib/session-asks');
const { seedProject } = await import('./helpers/integration-fixtures');

type SeededProject = Awaited<ReturnType<typeof seedProject>>;
let project: SeededProject;

async function seedSession(parentSessionId: string | null = null): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    status: 'running',
    parentSessionId,
  });
  return sessionId;
}

const HASH = 'a'.repeat(64);

async function askPermission(sessionId: string, requestId: string, expiresAt = askExpiresAt()) {
  const recorded = await recordPendingPermission({
    accountId: project.account_id,
    projectId: project.project_id,
    sessionId,
    surfaceSessionId: await surfaceSessionIdOf(sessionId),
    requestId,
    runtimeSessionId: 'ses_root',
    tool: 'bash',
    permission: 'bash',
    patterns: ['git push origin main'],
    args: { command: 'git push origin main' },
    argsHash: HASH,
    expiresAt,
  });
  return recorded!;
}

beforeAll(async () => {
  project = await seedProject('session-asks');
});

describe('parked questions', () => {
  test('a parkable question outlives the turn end and a later prompt; another question closes', async () => {
    const sessionId = await seedSession();
    const base = { accountId: project.account_id, projectId: project.project_id, sessionId, questions: [{ question: 'Which way?', header: 'Pick', options: [] }] };
    await recordPendingQuestion({ ...base, requestId: 'que_parked', parkable: true, expiresAt: askExpiresAt() });
    await recordPendingQuestion({ ...base, requestId: 'que_workflow', parkable: false });

    // The turn end and a delivered prompt pass `keepParked`.
    expect(await clearOpenQuestions(sessionId, { keepParked: true })).toBe(1);
    expect(await clearOpenQuestions(sessionId, { askedBefore: new Date(Date.now() + 60_000), keepParked: true })).toBe(0);
    const open = await listOpenAsks({ projectId: project.project_id, sessionIds: [sessionId] });
    expect(open.map((ask) => [ask.kind, ask.request_id])).toEqual([['question', 'que_parked']]);
    // A person's answer (by request id) closes it.
    expect(await clearOpenQuestions(sessionId, { requestId: 'que_parked' })).toBe(1);
    expect(await listOpenAsks({ projectId: project.project_id, sessionIds: [sessionId] })).toEqual([]);
  });
});

describe('permission asks', () => {
  test('an approval given while the call was parked is consumed by exactly one re-run', async () => {
    const sessionId = await seedSession();
    const ask = await askPermission(sessionId, 'perm_once');
    expect(ask.inserted).toBe(true);
    // A relay retry stores nothing new.
    expect((await askPermission(sessionId, 'perm_once')).inserted).toBe(false);
    expect(await takeApprovedCall(sessionId, HASH)).toBeNull();

    expect(await decidePendingPermission({ id: ask.id, decision: 'once', decidedBy: null })).toBe(true);
    // A second decision loses the compare-and-set.
    expect(await decidePendingPermission({ id: ask.id, decision: 'reject', decidedBy: null })).toBe(false);
    const [first, second] = await Promise.all([takeApprovedCall(sessionId, HASH), takeApprovedCall(sessionId, HASH)]);
    expect([first, second].filter(Boolean)).toEqual([{ decision: 'once', permission: 'bash' }]);
    expect(await takeApprovedCall(sessionId, HASH)).toBeNull();
    // Another call (another hash) or another session never uses it.
    expect(await takeApprovedCall(await seedSession(), HASH)).toBeNull();
  });

  test('a denial is never consumed by a re-run', async () => {
    const sessionId = await seedSession();
    const ask = await askPermission(sessionId, 'perm_reject');
    await decidePendingPermission({ id: ask.id, decision: 'reject', decidedBy: null });
    expect(await takeApprovedCall(sessionId, HASH)).toBeNull();
  });

  test('an expired ask waits on nobody and cannot be decided', async () => {
    const sessionId = await seedSession();
    const ask = await askPermission(sessionId, 'perm_expired', new Date(Date.now() - 1_000).toISOString());
    expect(await listOpenAsks({ projectId: project.project_id, sessionIds: [sessionId] })).toEqual([]);
    expect(await decidePendingPermission({ id: ask.id, decision: 'once', decidedBy: null })).toBe(false);
  });

  test('a hidden worker\'s ask shows on its root session, and is live only inside the window', async () => {
    const root = await seedSession();
    const worker = await seedSession(await seedSession(root));
    expect(await surfaceSessionIdOf(worker)).toBe(root);
    const ask = await askPermission(worker, 'perm_worker');
    const onRoot = await listOpenAsks({ projectId: project.project_id, surfaceSessionId: root });
    expect(onRoot.map((a) => [a.id, a.session_id, a.surface_session_id, a.title])).toEqual([
      [`permission:${ask.id}`, worker, root, 'bash: git push origin main'],
    ]);
    expect(await sessionHasLiveAsk(worker)).toBe(true);
    await db
      .update(sessionPendingPermissions)
      .set({ askedAt: new Date(Date.now() - ASK_LIVE_WAIT_MS - 1_000).toISOString() })
      .where(eq(sessionPendingPermissions.id, ask.id));
    expect(await sessionHasLiveAsk(worker)).toBe(false);
  });
});

describe('live wait policy', () => {
  test('nobody watches a trigger, an unattended or a worker session: its asks park at once', () => {
    expect(liveWaitMsFor({ origin: 'user', metadata: {}, parentSessionId: null })).toBe(ASK_LIVE_WAIT_MS);
    expect(liveWaitMsFor({ origin: 'trigger', metadata: {}, parentSessionId: null })).toBe(0);
    expect(liveWaitMsFor({ origin: 'user', metadata: { source: 'trigger:nightly' }, parentSessionId: null })).toBe(0);
    expect(liveWaitMsFor({ origin: 'user', metadata: { unattended: true }, parentSessionId: null })).toBe(0);
    expect(liveWaitMsFor({ origin: 'user', metadata: {}, parentSessionId: 'parent' })).toBe(0);
  });
});
