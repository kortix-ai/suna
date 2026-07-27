/**
 * R-33's hooks, from the OTHER side: not "does the writeback work" (that is
 * integration-agi-liveness.test.ts) but "is it wired to every path that ends a
 * session".
 *
 * The gap this covers was real. `recordSessionOutcomeBestEffort` was called from
 * the three session-lifecycle paths only — stop, delete, dead-letter — all of
 * which are things a HUMAN or a queue does. The paths that end an UNATTENDED
 * session were unhooked:
 *
 *   • the idle reaper (`reconcileRowToStopped`), which is how most trigger
 *     sessions end, because nobody presses stop on a 07:00 cron push;
 *   • the provider stop webhook / sweep (`reconcileSandboxStoppedByExternalId`);
 *   • `preserveEstablishedRuntime`, the runtime-unavailable path — the worst
 *     case for a claim, since the sandbox is never coming back.
 *
 * A task claimed by one of those sessions only came back on claim-TTL lapse,
 * hours later, instead of promptly.
 *
 * Real DB, and the assertion polls: the hook is deliberately fire-and-forget
 * (a liveness failure must never fail a stop), so the caller returns before the
 * writeback lands. Polling is what the production reader does too.
 *
 * Run with:
 *   KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- \
 *     bun test src/agi/liveness/integration-agi-terminal-hooks.test.ts
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  agiTasks,
  projectMembers,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../../shared/db';
// The two `projects/` modules load FIRST on purpose. Both AGI stores and the
// project serializers sit in one import cycle, and entering it from the AGI side
// leaves `tasks/wire`'s consts uninitialized when `liveness/store` reads them
// (`Cannot access 'OPEN_TASK_STATUSES' before initialization`). Entering from
// `projects/` is the order the app itself boots in.
import { preserveEstablishedRuntime } from '../../projects/runtime-identity';
import { reconcileSandboxStoppedByExternalId } from '../../projects/sandbox-reaper';
import { claimTask, createTask, loadTask } from '../tasks/store';

const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const OWNER = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agi-terminal-hooks-test' });
  await db.insert(projects).values({
    projectId: WORKSPACE,
    accountId: ACCOUNT,
    name: 'agi-terminal-hooks-workspace',
    repoUrl: 'https://example.com/agi-terminal-hooks.git',
    metadata: { experimental: { agi: true } },
  });
  await db.insert(accountMembers).values({
    userId: OWNER,
    accountId: ACCOUNT,
    accountRole: 'owner',
    isSuperAdmin: false,
  });
  await db.insert(projectMembers).values({
    accountId: ACCOUNT,
    projectId: WORKSPACE,
    userId: OWNER,
    projectRole: 'manager',
  });
});

/**
 * Tear down the runtime rows.
 *
 * `guard_session_sandbox_identity` REFUSES to delete a sandbox row that still
 * carries an external_id unless its session is marked deleted — an established
 * runtime is an immutable identity boundary, and the guard does not care that
 * this is a test. So the sessions are marked deleted first, which is exactly
 * what the production delete path does before it drops the row.
 */
async function cleanupRuntime(): Promise<void> {
  await db
    .update(projectSessions)
    .set({
      metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || jsonb_build_object('deletedAt', now()::text)`,
    })
    .where(eq(projectSessions.projectId, WORKSPACE));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, WORKSPACE));
  await db.delete(projectSessions).where(inArray(projectSessions.projectId, [WORKSPACE]));
  await db.delete(agiTasks).where(eq(agiTasks.workspaceId, WORKSPACE));
}

afterAll(async () => {
  await cleanupRuntime();
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

beforeEach(cleanupRuntime);

let counter = 0;

/** A session with a sandbox that has a provider object — an "established"
 *  runtime, which is the only kind these paths act on. */
async function establishedSession(): Promise<{ sessionId: string; externalId: string }> {
  counter += 1;
  const sessionId = `ses-hooks-${crypto.randomUUID()}`;
  const externalId = `ext-hooks-${crypto.randomUUID()}`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: WORKSPACE,
    branchName: `hooks/${counter}-${crypto.randomUUID().slice(0, 8)}`,
    status: 'running',
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: ACCOUNT,
    projectId: WORKSPACE,
    provider: 'daytona',
    externalId,
    status: 'active',
  });
  return { sessionId, externalId };
}

async function claimedTask(sessionId: string): Promise<string> {
  const { row } = await createTask({
    workspaceId: WORKSPACE,
    title: 'Work the unattended session picked up',
    body: null,
    goalSlug: 'oil-desk',
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
  });
  const claimed = await claimTask({
    workspaceId: WORKSPACE,
    taskId: row.taskId,
    sessionId,
    ttlSeconds: 900,
    status: 'doing',
  });
  expect(claimed?.claimSessionId).toBe(sessionId);
  return row.taskId;
}

/** The writeback is fire-and-forget, so the caller returns first. Poll rather
 *  than sleep a fixed amount: a fixed sleep is either flaky or slow. */
async function waitForRelease(taskId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = await loadTask(WORKSPACE, taskId);
    if (row && row.claimSessionId === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const sandboxRow = (sessionId: string) =>
  db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1)
    .then(([row]) => row);

describe('terminal paths that end an unattended session (R-33)', () => {
  test('preserveEstablishedRuntime releases the dead session’s claim', async () => {
    const { sessionId } = await establishedSession();
    const taskId = await claimedTask(sessionId);

    await preserveEstablishedRuntime(await sandboxRow(sessionId), 'test_runtime_unavailable');

    // The session is terminal now, so the lease it held is dead. Nothing else
    // will ever come back for it — this hook is the only prompt release.
    expect(
      (await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)))[0]
        .status,
    ).toBe('stopped');
    expect(await waitForRelease(taskId)).toBe(true);
  });

  test('the provider-stop reconcile releases the claim too', async () => {
    const { sessionId, externalId } = await establishedSession();
    const taskId = await claimedTask(sessionId);

    expect(await reconcileSandboxStoppedByExternalId(externalId)).toBe(true);
    expect(await waitForRelease(taskId)).toBe(true);
  });

  test('the writeback records what the session did, not just that it ended', async () => {
    const { sessionId, externalId } = await establishedSession();
    const taskId = await claimedTask(sessionId);

    await reconcileSandboxStoppedByExternalId(externalId);
    expect(await waitForRelease(taskId)).toBe(true);

    const [row] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId));
    const outcome = (row.metadata as any).agi_liveness;
    // R-33's "MUST be visible": a session that took a claim and wrote nothing is
    // the no-progress case, and the count is the number a human scans for.
    expect(outcome.no_progress_count).toBe(1);
    expect(outcome.claims[0]).toMatchObject({ task_id: taskId, progressed: false });
  });

  test('a reconcile that transitions nothing is a no-op', async () => {
    // Already stopped: the reconcile returns false before touching the session,
    // so nothing is written back and no claim can be broken.
    const { sessionId, externalId } = await establishedSession();
    await db
      .update(sessionSandboxes)
      .set({ status: 'stopped' })
      .where(eq(sessionSandboxes.sessionId, sessionId));
    const taskId = await claimedTask(sessionId);

    expect(await reconcileSandboxStoppedByExternalId(externalId)).toBe(false);
    expect((await loadTask(WORKSPACE, taskId))?.claimSessionId).toBe(sessionId);
  });

  test('two overlapping terminal paths on the same session do not double-record', async () => {
    const { sessionId, externalId } = await establishedSession();
    const taskId = await claimedTask(sessionId);

    // The webhook and the reaper can both observe the same stop. The second call
    // finds the row already stopped and returns false, and even if it did run,
    // the release is holder-scoped and the writeback is idempotent.
    await reconcileSandboxStoppedByExternalId(externalId);
    expect(await waitForRelease(taskId)).toBe(true);
    await reconcileSandboxStoppedByExternalId(externalId);

    // Exactly one continuation at most, and the claim stays released — never
    // re-taken, never duplicated.
    const children = await db.select().from(agiTasks).where(eq(agiTasks.parentId, taskId));
    expect(children.length).toBeLessThanOrEqual(1);
    expect((await loadTask(WORKSPACE, taskId))?.claimSessionId).toBeNull();
  });

  test('a workspace without the agi key is untouched by any of them (R-44)', async () => {
    await db
      .update(projects)
      .set({ metadata: sql`'{}'::jsonb` })
      .where(eq(projects.projectId, WORKSPACE));
    try {
      const { sessionId, externalId } = await establishedSession();
      const taskId = await claimedTask(sessionId);

      await reconcileSandboxStoppedByExternalId(externalId);
      // Give the fire-and-forget hook the same window the positive cases get,
      // then assert it did NOT act.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await loadTask(WORKSPACE, taskId))?.claimSessionId).toBe(sessionId);
    } finally {
      await db
        .update(projects)
        .set({ metadata: { experimental: { agi: true } } })
        .where(eq(projects.projectId, WORKSPACE));
    }
  });
});
