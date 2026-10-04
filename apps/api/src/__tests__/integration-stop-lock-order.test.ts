/**
 * Real-PostgreSQL proof that the park write (`applyStoppedState`, the manual
 * Stop / reaper / webhook stop) takes row locks in the SAME order as
 * `transitionRuntime` (the wake, resume and restart writer): the
 * `project_sessions` row first, the `session_sandboxes` row second.
 *
 * Opposite orders deadlock (SQLSTATE 40P01): a wake holds the session row and
 * waits for the sandbox row while a stop holds the sandbox row and waits for
 * the session row. A mocked `db` cannot show that; only two real transactions
 * can.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { applyStoppedState } from '../projects/reaping/sandbox-state-sync';
import { transitionRuntime } from '../projects/session-lifecycle/status-transitions';
import { db } from '../lib/db';

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `stop-lock-order-${SANDBOX_ID}`;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Stop lock order' });
  await db.insert(projects).values({
    projectId: PROJECT_ID, accountId: ACCOUNT_ID, name: 'Stop lock order', repoUrl: 'https://example.test/r.git',
  });
});

afterAll(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, SANDBOX_ID)).catch(() => undefined);
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION_ID)).catch(() => undefined);
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID)).catch(() => undefined);
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID)).catch(() => undefined);
});

async function seed(): Promise<void> {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, SANDBOX_ID));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION_ID));
  await db.insert(projectSessions).values({
    sessionId: SESSION_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, branchName: `b/${SESSION_ID}`, status: 'running',
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: SANDBOX_ID, sessionId: SESSION_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
    status: 'active', provider: 'daytona', externalId: 'ext-stop-lock-order', metadata: {},
  });
}

describe('stop vs wake lock order (real PostgreSQL)', () => {
  test('a stop racing a wake-style runtime transition never deadlocks', async () => {
    await seed();
    // The wake holds the session row, then dwells in the sandbox UPDATE's
    // WHERE clause (pg_sleep) BEFORE it locks the sandbox row. The stop starts
    // in that window.
    const wake = transitionRuntime({
      sessionId: SESSION_ID,
      sandboxId: SANDBOX_ID,
      session: 'resume',
      sandbox: 'stop',
      at: new Date(),
      guard: sql`pg_sleep(1.5) IS NOT NULL`,
    });
    await Bun.sleep(400);
    const stop = applyStoppedState({
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
      externalId: 'ext-stop-lock-order',
      stopReason: 'manual',
      now: new Date(),
    });
    const [wakeResult, stopResult] = await Promise.allSettled([wake, stop]);
    expect(stopResult.status === 'rejected' ? String(stopResult.reason) : 'ok').toBe('ok');
    expect(wakeResult.status === 'rejected' ? String(wakeResult.reason) : 'ok').toBe('ok');
    const [row] = await db.select({ status: sessionSandboxes.status }).from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, SANDBOX_ID));
    expect(row?.status).toBe('stopped');
  }, 30_000);
});
