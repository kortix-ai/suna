import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { accountMembers, accounts, agiTasks, projectMembers, projectSessions, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { app } from '../../index';
import { createAccountToken } from '../../repositories/account-tokens';
import { claimTask, createTask, loadTask, patchTask } from '../tasks/store';
import { recordSessionOutcome } from './session-outcome';
import { sweepWorkspaceLiveness } from './surface';
import { stallFingerprint } from './wire';

// Real-DB integration. Everything that makes this module trustworthy is a
// property of the DATABASE — "at most one continuation" IS the partial unique
// index on origin_fingerprint, and "the claim is released" IS a holder-scoped
// conditional UPDATE — so a mocked store would test the mock.
//
// The `integration-` filename prefix is load-bearing: scripts/test.sh's default
// bucket excludes it, because that suite runs without a database. Run this with:
//   KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- \
//     bun test src/agi/liveness/integration-agi-liveness.test.ts
const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const WORKSPACE_OFF = crypto.randomUUID();
const OWNER = crypto.randomUUID();

const minted: string[] = [];
let ownerToken = '';

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agi-liveness-test' });
  await db.insert(projects).values([
    {
      projectId: WORKSPACE,
      accountId: ACCOUNT,
      name: 'agi-liveness-workspace',
      repoUrl: 'https://example.com/agi-liveness.git',
      metadata: { experimental: { agi: true } },
    },
    {
      projectId: WORKSPACE_OFF,
      accountId: ACCOUNT,
      name: 'agi-liveness-workspace-off',
      repoUrl: 'https://example.com/agi-liveness-off.git',
    },
  ]);
  await db.insert(accountMembers).values({
    userId: OWNER,
    accountId: ACCOUNT,
    accountRole: 'owner',
    isSuperAdmin: false,
  });
  await db.insert(projectMembers).values(
    [WORKSPACE, WORKSPACE_OFF].map((projectId) => ({
      accountId: ACCOUNT,
      projectId,
      userId: OWNER,
      projectRole: 'manager' as const,
    })),
  );

  const token = await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'agi-liveness' });
  minted.push(token.tokenId);
  ownerToken = token.secretKey;
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

beforeEach(async () => {
  await db.delete(agiTasks).where(inArray(agiTasks.workspaceId, [WORKSPACE, WORKSPACE_OFF]));
  await db.delete(projectSessions).where(inArray(projectSessions.projectId, [WORKSPACE, WORKSPACE_OFF]));
});

let branchCounter = 0;

async function session(input: {
  status: 'running' | 'stopped' | 'failed' | 'completed';
  projectId?: string;
}): Promise<string> {
  const sessionId = `ses-liveness-${crypto.randomUUID()}`;
  branchCounter += 1;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: input.projectId ?? WORKSPACE,
    branchName: `liveness/${branchCounter}-${crypto.randomUUID().slice(0, 8)}`,
    status: input.status,
  });
  return sessionId;
}

async function task(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const { row } = await createTask({
    workspaceId: WORKSPACE,
    title: 'Rebalance the book',
    body: null,
    goalSlug: null,
    project: null,
    parentId: null,
    status: 'todo',
    priority: 'medium',
    agent: 'trader',
    assigneeUserId: null,
    blockedBy: [],
    triggerSlug: null,
    origin: 'trigger',
    originFingerprint: null,
    ...overrides,
  });
  return row;
}

async function get(path: string) {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${ownerToken}` } });
  return { status: res.status, body: (await res.json()) as any };
}

async function post(path: string) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('session → task writeback (R-33)', () => {
  test('a terminal session that recorded nothing releases its claim and is recorded as no progress', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task();
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 900,
      status: 'doing',
    });

    const outcome = await recordSessionOutcome({ sessionId });

    expect(outcome.skipped).toBeNull();
    expect(outcome.claims).toHaveLength(1);
    expect(outcome.claims[0]).toMatchObject({
      taskId: created.taskId,
      progressed: false,
      evidence: 'untouched_since_claim',
      state: 'stalled',
      recovery: 'continued',
    });

    // R-31: the session ending is NOT a status change. The task stays exactly
    // where the session left it; only the dead lease is cleared.
    const after = await loadTask(WORKSPACE, created.taskId);
    expect(after?.status).toBe('doing');
    expect(after?.claimSessionId).toBeNull();
    expect(after?.claimExpiresAt).toBeNull();
  });

  test('the determination is visible on the session it came from', async () => {
    const sessionId = await session({ status: 'failed' });
    const created = await task();
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId, ttlSeconds: 900 });

    await recordSessionOutcome({ sessionId });

    const [row] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId));
    const recorded = (row.metadata as any).agi_liveness;
    expect(recorded.no_progress_count).toBe(1);
    expect(recorded.claims[0]).toMatchObject({
      task_id: created.taskId,
      progressed: false,
      evidence: 'untouched_since_claim',
    });
  });

  test('a session that changed the status is progress, and a task with a path is left alone', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task({ goalSlug: 'oil-desk' });
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId, ttlSeconds: 900 });
    // The one thing R-31 accepts as a control-plane act.
    await patchTask(WORKSPACE, created.taskId, { status: 'review', body: 'waiting on the exchange' });

    const outcome = await recordSessionOutcome({ sessionId });

    expect(outcome.claims[0]).toMatchObject({
      progressed: true,
      evidence: 'task_written',
      state: 'awaiting_trigger',
      recovery: null,
    });
    expect(await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId))).toHaveLength(0);
  });

  test('progress and liveness are independent — a progressed task with no path still stalls', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task();
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId, ttlSeconds: 900 });
    // R-16: `status: 'blocked'` with an empty `blocked_by` names no blocker, so
    // nothing resolves it and nothing will pick it up again.
    await patchTask(WORKSPACE, created.taskId, { status: 'blocked', body: 'waiting on the exchange' });

    const outcome = await recordSessionOutcome({ sessionId });

    expect(outcome.claims[0]).toMatchObject({
      progressed: true,
      state: 'stalled',
      recovery: 'continued',
    });
  });

  test('creating work underneath the task counts as progress (R-11)', async () => {
    const sessionId = await session({ status: 'stopped' });
    const parent = await task({ goalSlug: 'oil-desk' });
    await claimTask({ workspaceId: WORKSPACE, taskId: parent.taskId, sessionId, ttlSeconds: 900 });
    await task({ parentId: parent.taskId, title: 'Wire the exchange adapter' });

    const outcome = await recordSessionOutcome({ sessionId });

    expect(outcome.claims[0]).toMatchObject({ progressed: true, evidence: 'children_created' });
  });

  test('a task under a goal needs no continuation — clearing the lease restores its live path', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task({ goalSlug: 'oil-desk' });
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId, ttlSeconds: 900 });

    const outcome = await recordSessionOutcome({ sessionId });

    expect(outcome.claims[0]).toMatchObject({
      progressed: false,
      state: 'awaiting_trigger',
      recovery: null,
    });
    expect(await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId))).toHaveLength(0);
  });

  test("a live session's claim is never broken, even by a caller that races the status flip (R-19)", async () => {
    const sessionId = await session({ status: 'running' });
    const created = await task();
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId, ttlSeconds: 900 });

    const outcome = await recordSessionOutcome({ sessionId });

    expect(outcome.skipped).toBe('session_not_terminal');
    expect((await loadTask(WORKSPACE, created.taskId))?.claimSessionId).toBe(sessionId);
  });

  test('a workspace without the agi key is never touched (R-44)', async () => {
    const sessionId = await session({ status: 'stopped', projectId: WORKSPACE_OFF });
    const outcome = await recordSessionOutcome({ sessionId });
    expect(outcome.skipped).toBe('agi_disabled');
  });

  test('an unknown session id is a no-op, not a throw', async () => {
    expect((await recordSessionOutcome({ sessionId: 'ses-does-not-exist' })).skipped).toBe(
      'unknown_session',
    );
  });

  test('a terminal session holding no claims writes nothing', async () => {
    const sessionId = await session({ status: 'stopped' });
    expect((await recordSessionOutcome({ sessionId })).skipped).toBe('no_claims');
  });
});

describe('bounded recovery (R-32)', () => {
  test('the continuation preserves ownership and cites the stalled task', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task({ agent: 'trader', triggerSlug: null });
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 900,
      status: 'doing',
    });
    await recordSessionOutcome({ sessionId });

    const [continuation] = await db
      .select()
      .from(agiTasks)
      .where(eq(agiTasks.parentId, created.taskId));

    // R-14/R-32: same agent, never a different one, and never both assignees.
    expect(continuation.agent).toBe('trader');
    expect(continuation.assigneeUserId).toBeNull();
    expect(continuation.title).toBe('Stalled: Rebalance the book');
    expect(continuation.originFingerprint).toBe(
      stallFingerprint({ taskId: created.taskId, taskStatus: 'doing', reason: 'no_live_path' }),
    );
    expect(continuation.body).toContain(sessionId);
  });

  test('identical repeated evidence escalates instead of continuing again', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task();
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 900,
      status: 'doing',
    });
    await recordSessionOutcome({ sessionId });

    // Second observation of the SAME stalled state — a second crashed session on
    // the same untouched task is not new evidence.
    const secondSession = await session({ status: 'failed' });
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId: secondSession,
      ttlSeconds: 900,
    });
    const second = await recordSessionOutcome({ sessionId: secondSession });

    expect(second.claims[0].recovery).toBe('escalated');

    const children = await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId));
    expect(children).toHaveLength(1);
    expect(children[0].agent).toBeNull();
    expect(children[0].assigneeUserId).toBe(OWNER);
    expect(children[0].priority).toBe('urgent');
    expect(children[0].title).toBe('Escalated: Rebalance the book');
    // The evidence written at continuation time survives escalation untouched.
    expect(children[0].body).toContain(sessionId);
  });

  test('a third observation does nothing at all — recovery stops', async () => {
    const created = await task({ status: 'doing' });
    for (const _ of [1, 2, 3]) {
      const sessionId = await session({ status: 'stopped' });
      await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId, ttlSeconds: 900 });
      await recordSessionOutcome({ sessionId });
    }

    const steps = await sweepWorkspaceLiveness({ workspaceId: WORKSPACE, accountId: ACCOUNT });
    const recoveries = steps.outcomes.filter((outcome) => outcome.recovery !== null);
    expect(recoveries.every((outcome) => outcome.recovery!.step === 'already_escalated')).toBe(true);
    expect(await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId))).toHaveLength(1);
  });

  test('a status change makes it a DIFFERENT stalled state, which may be continued once', async () => {
    const created = await task({ status: 'doing' });
    const first = await session({ status: 'stopped' });
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId: first, ttlSeconds: 900 });
    await recordSessionOutcome({ sessionId: first });

    await patchTask(WORKSPACE, created.taskId, { status: 'review' });
    const second = await session({ status: 'stopped' });
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId: second, ttlSeconds: 900 });
    const outcome = await recordSessionOutcome({ sessionId: second });

    expect(outcome.claims[0].recovery).toBe('continued');
    expect(await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId))).toHaveLength(2);
  });
});

describe('the stall surface', () => {
  test('a crashed session with an unexpired lease is stalled on the next read, hook or no hook', async () => {
    const sessionId = await session({ status: 'failed' });
    const created = await task({ goalSlug: 'oil-desk' });
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 900,
      status: 'doing',
    });

    // No writeback ran — this is the hard-crash case.
    const { status, body } = await get(`/v1/projects/${WORKSPACE}/agi/liveness`);
    expect(status).toBe(200);
    expect(body.stalled_count).toBe(1);
    expect(body.stalled[0].task.task_id).toBe(created.taskId);
    expect(body.stalled[0].liveness).toMatchObject({
      state: 'stalled',
      reason: 'claiming_session_terminal',
      claim_session_state: 'terminal',
    });
  });

  test('the sweep clears the dead lease and, for a goal-backed task, stops there', async () => {
    const sessionId = await session({ status: 'failed' });
    const created = await task({ goalSlug: 'oil-desk' });
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 900,
      status: 'doing',
    });

    const { status, body } = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    expect(status).toBe(200);
    expect(body.stalled).toBe(1);
    expect(body.outcomes[0]).toMatchObject({
      task_id: created.taskId,
      claim_released: true,
      reason: 'awaiting_trigger',
      recovery: null,
    });

    const after = await get(`/v1/projects/${WORKSPACE}/agi/liveness`);
    expect(after.body.stalled_count).toBe(0);
  });

  test('the sweep is idempotent — running it twice produces one continuation', async () => {
    const sessionId = await session({ status: 'failed' });
    const created = await task();
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 900,
      status: 'doing',
    });

    const first = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    expect(first.body.outcomes[0].recovery.step).toBe('continued');

    const second = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    const forTask = second.body.outcomes.find((o: any) => o.task_id === created.taskId);
    expect(forTask.recovery.step).toBe('escalated');

    const third = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    const again = third.body.outcomes.find((o: any) => o.task_id === created.taskId);
    expect(again.recovery.step).toBe('already_escalated');
    expect(await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId))).toHaveLength(1);
  });

  test('an untended backlog task is surfaced as stalled but never auto-continued', async () => {
    // Stalled by R-28 (agent-owned, no claim, no goal, no trigger) — but stalled
    // because a human has not scheduled it, which is a report, not a crash.
    const created = await task({ status: 'backlog' });

    const { body } = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    expect(body.outcomes[0]).toMatchObject({
      task_id: created.taskId,
      reason: 'no_live_path',
      recovery: null,
    });
    expect(await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId))).toHaveLength(0);

    const surface = await get(`/v1/projects/${WORKSPACE}/agi/liveness`);
    expect(surface.body.stalled_count).toBe(1);
  });

  test('a recovery row is not itself reported as stalled work', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task();
    await claimTask({ workspaceId: WORKSPACE, taskId: created.taskId, sessionId, ttlSeconds: 900 });
    await recordSessionOutcome({ sessionId });

    const { body } = await get(`/v1/projects/${WORKSPACE}/agi/liveness`);
    const ids = body.tasks.map((view: any) => view.task.task_id);
    expect(ids).toEqual([created.taskId]);
  });

  test('the stalled task carries a pointer to the recovery row it produced', async () => {
    const sessionId = await session({ status: 'stopped' });
    const created = await task();
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 900,
      status: 'doing',
    });
    await recordSessionOutcome({ sessionId });

    const { body } = await get(`/v1/projects/${WORKSPACE}/agi/liveness`);
    expect(body.stalled[0].liveness.recovery).toMatchObject({ escalated: false, escalated_to: null });
    expect(body.stalled[0].liveness.recovery.task_id).toBeTruthy();
  });

  // The defect this closes: recovery inserts its continuation with
  // `parent_id` = the stalled task, and "tasks created under it after the claim"
  // is a progress signal. So from the second sweep on, a task that has done
  // nothing reported progressed:true on the strength of an artifact recovery
  // itself produced. The bound still held and escalation still fired, but the
  // evidence was circular, and a genuinely dead task read as alive to anyone
  // scanning for no-progress.
  //
  // `claim_expired` is the shape that exposes it: the sweep only RELEASES a
  // claim whose session is terminal, so an expired lease held by a live session
  // keeps `claimed_at` on the row across sweeps — and the continuation is
  // created after it.
  test('a recovery continuation is not counted as its own parent making progress', async () => {
    const sessionId = await session({ status: 'running' });
    const created = await task({ status: 'doing' });
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 30,
    });
    // Expire the lease without releasing it: `claimed_at` stays, which is what
    // the progress window is measured from.
    await db
      .update(agiTasks)
      .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(agiTasks.taskId, created.taskId));

    const first = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    const firstOutcome = first.body.outcomes.find((o: any) => o.task_id === created.taskId);
    expect(firstOutcome.reason).toBe('claim_expired');
    expect(firstOutcome.progressed).toBe(false);
    expect(firstOutcome.recovery.step).toBe('continued');

    const second = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    const secondOutcome = second.body.outcomes.find((o: any) => o.task_id === created.taskId);
    // The continuation now exists underneath this task and was created after the
    // claim. It must not read as the task having moved.
    expect(
      await db.select().from(agiTasks).where(eq(agiTasks.parentId, created.taskId)),
    ).toHaveLength(1);
    expect(secondOutcome.progressed).toBe(false);
  });

  test('a REAL child created after the claim still counts as progress', async () => {
    const sessionId = await session({ status: 'running' });
    const created = await task({ status: 'doing' });
    await claimTask({
      workspaceId: WORKSPACE,
      taskId: created.taskId,
      sessionId,
      ttlSeconds: 30,
    });
    await db
      .update(agiTasks)
      .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(agiTasks.taskId, created.taskId));
    // Ordinary work, no stall fingerprint — the positive control that proves the
    // exclusion above is narrow and did not just delete the signal.
    await task({ parentId: created.taskId, title: 'Wire the exchange adapter' });

    const { body } = await post(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`);
    const outcome = body.outcomes.find((o: any) => o.task_id === created.taskId);
    expect(outcome.progressed).toBe(true);
  });

  test('an invalid limit is a 400, not a silent default', async () => {
    const res = await get(`/v1/projects/${WORKSPACE}/agi/liveness?limit=0`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid limit');
  });

  test('both routes are 404 when agi is off (R-44)', async () => {
    expect((await get(`/v1/projects/${WORKSPACE_OFF}/agi/liveness`)).status).toBe(404);
    expect((await post(`/v1/projects/${WORKSPACE_OFF}/agi/liveness/sweep`)).status).toBe(404);
  });

  test('both routes are 401 without a token', async () => {
    expect((await app.request(`/v1/projects/${WORKSPACE}/agi/liveness`)).status).toBe(401);
    expect(
      (await app.request(`/v1/projects/${WORKSPACE}/agi/liveness/sweep`, { method: 'POST' })).status,
    ).toBe(401);
  });
});
