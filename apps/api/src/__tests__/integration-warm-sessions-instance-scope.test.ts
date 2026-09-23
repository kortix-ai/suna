/**
 * Real-DB proof that `findWarmProjectSession` (../projects/routes/warm-sessions.ts)
 * never hands out a warm session that belongs to ANOTHER local API instance.
 *
 * 2026-09-22: several worktree APIs share one local Postgres. Each API tags the
 * sandboxes it provisions with `session_sandboxes.metadata.instanceId`, and
 * inbox delivery (`claimDueLifecycleCommands`) refuses rows whose sandbox
 * carries another instance's id (../projects/instance-scope.ts). The warm-pool
 * lookup did not apply that scope: `POST /sessions/warm` on the
 * `session-reply-queue` API returned `reused: true` for a warm session whose
 * sandbox was tagged `first-chat`. Every prompt the user then sends through
 * this API becomes an inbox row this API refuses to claim, so it stays
 * `queued` with `attempts = 0` until the owning API runs again. The same day
 * the local DB held 55 due-but-unclaimed `queued` rows on warm-created
 * sandboxes tagged by 10 other instances.
 *
 * Deployed environments leave `KORTIX_INSTANCE_ID` unset: the lookup must be
 * unchanged there.
 *
 * Real local Postgres, no `mock.module` — same shape as
 * `./integration-warm-sessions-exclude.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../config';
import { findWarmProjectSession } from '../projects/routes/warm-sessions';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const ME = 'wt-me';
const OTHER = 'wt-other';

const ORIGINAL_INSTANCE = (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID;
const setInstance = (value: string | undefined) => {
  (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID = value;
};

/**
 * One warm session. `box` is the sandbox row's metadata (omit for "no sandbox
 * row yet" — the create path inserts it after the session row).
 * `sessionInstance` is the instance stamp on the session row's own metadata.
 */
async function seedWarmSession(opts: {
  box?: Record<string, unknown>;
  sessionInstance?: string;
  createdAt?: Date;
}): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: USER,
    status: 'running',
    metadata: {
      warm: true,
      ...(opts.sessionInstance !== undefined ? { instanceId: opts.sessionInstance } : {}),
    },
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  if (opts.box) {
    await db.insert(sessionSandboxes).values({
      sandboxId: sessionId,
      sessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      status: 'active',
      metadata: { warm: true, ...opts.box },
    });
  }
  return sessionId;
}

const lookup = () => findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER });

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'warm-sessions-instance-scope-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
});

afterAll(async () => {
  setInstance(ORIGINAL_INSTANCE);
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

beforeEach(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, ACCOUNT));
  await db.delete(projectSessions).where(eq(projectSessions.accountId, ACCOUNT));
});

afterEach(() => setInstance(ORIGINAL_INSTANCE));

describe('findWarmProjectSession — KORTIX_INSTANCE_ID set (local shared DB)', () => {
  beforeEach(() => setInstance(ME));

  test('a warm session whose sandbox is tagged with ANOTHER instance is never returned', async () => {
    await seedWarmSession({ box: { instanceId: OTHER } });

    expect(await lookup()).toBeNull();
  });

  test('a newer foreign warm session is skipped, and this instance\'s older one is returned', async () => {
    const mine = await seedWarmSession({ box: { instanceId: ME }, createdAt: new Date(Date.now() - 60_000) });
    await seedWarmSession({ box: { instanceId: OTHER } });

    expect((await lookup())?.sessionId).toBe(mine);
  });

  test('a warm session whose sandbox is tagged with THIS instance is returned', async () => {
    const sessionId = await seedWarmSession({ box: { instanceId: ME } });

    expect((await lookup())?.sessionId).toBe(sessionId);
  });

  test('a legacy sandbox (no instanceId) is returned', async () => {
    const sessionId = await seedWarmSession({ box: {} });

    expect((await lookup())?.sessionId).toBe(sessionId);
  });

  test("a sandbox with instanceId '' reads as legacy and is returned", async () => {
    const sessionId = await seedWarmSession({ box: { instanceId: '' } });

    expect((await lookup())?.sessionId).toBe(sessionId);
  });

  test('no sandbox row yet, session stamped by ANOTHER instance → not returned (its provisioning will tag it foreign)', async () => {
    await seedWarmSession({ sessionInstance: OTHER });

    expect(await lookup()).toBeNull();
  });

  test('no sandbox row yet, session stamped by THIS instance → returned', async () => {
    const sessionId = await seedWarmSession({ sessionInstance: ME });

    expect((await lookup())?.sessionId).toBe(sessionId);
  });

  test('no sandbox row yet, unstamped legacy session → returned', async () => {
    const sessionId = await seedWarmSession({});

    expect((await lookup())?.sessionId).toBe(sessionId);
  });
});

describe('findWarmProjectSession — KORTIX_INSTANCE_ID unset (deployed): unchanged', () => {
  beforeEach(() => setInstance(undefined));

  test('a sandbox tagged with any instance is returned', async () => {
    const sessionId = await seedWarmSession({ box: { instanceId: OTHER } });

    expect((await lookup())?.sessionId).toBe(sessionId);
  });

  test('a session stamped with any instance and no sandbox row is returned', async () => {
    const sessionId = await seedWarmSession({ sessionInstance: OTHER });

    expect((await lookup())?.sessionId).toBe(sessionId);
  });

  test('the newest warm session wins, whatever its tag', async () => {
    await seedWarmSession({ box: { instanceId: ME }, createdAt: new Date(Date.now() - 60_000) });
    const newest = await seedWarmSession({ box: { instanceId: OTHER } });

    expect((await lookup())?.sessionId).toBe(newest);
  });
});
