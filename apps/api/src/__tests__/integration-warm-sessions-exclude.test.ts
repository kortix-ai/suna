/**
 * JAY-596 / T20 — real-DB proof that `findWarmProjectSession` (see
 * `../projects/routes/warm-sessions.ts`) actually skips an excluded session
 * id, even though its `metadata.warm` marker is still set.
 *
 * Root cause this covers: the marker only drops when the FIRST PROMPT reaches
 * the preview proxy (`recordSessionActivity`), seconds after the client
 * already consumed the session. Before this fix, a replenish racing that gap
 * found the just-taken session and handed it straight back as
 * `reused: true`. `takeWarmSession` (apps/web) then stored it back into
 * `ready[projectId]`, so the next "New Session" click reused the previous
 * conversation.
 *
 * Real local Postgres, no `mock.module` (process-wide in this app and a
 * hazard for sibling suites) — same shape as
 * `./integration-session-activity.test.ts`. Runs under `scripts/test.sh
 * integration`, not the default hermetic gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { findWarmProjectSession } from '../projects/routes/warm-sessions';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();

let n = 0;
async function seedWarmSession(
  overrides: {
    createdBy?: string;
    status?: 'queued' | 'branching' | 'provisioning' | 'running' | 'stopped' | 'failed' | 'completed';
    warm?: boolean;
    createdAt?: Date;
  } = {},
): Promise<string> {
  n += 1;
  const sessionId = `warm-excl-${n}-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: overrides.createdBy ?? USER,
    status: overrides.status ?? 'running',
    metadata: overrides.warm === false ? {} : { warm: true },
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
  return sessionId;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'warm-sessions-exclude-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions
});

// `findWarmProjectSession` picks the newest row for (account, project, user) —
// unlike a lookup keyed by a specific session id, it is NOT test-isolated by
// construction, so a session left behind by one test would poison the next.
beforeEach(async () => {
  await db.delete(projectSessions).where(eq(projectSessions.accountId, ACCOUNT));
});

describe('findWarmProjectSession — exclusion', () => {
  test('(b) with no exclusion, the live warm session is found — ordinary reuse still works', async () => {
    const sessionId = await seedWarmSession();

    const found = await findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER });

    expect(found?.sessionId).toBe(sessionId);
  });

  test('(c) the excluded id is never returned even though its warm marker is still set', async () => {
    const sessionId = await seedWarmSession();

    const found = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: USER,
      excludeSessionId: sessionId,
    });

    expect(found).toBeNull();
  });

  test('(a) excluding the only warm candidate leaves none available — the route then creates fresh instead of reusing', async () => {
    // The exact regression: a replenish that excludes the session it just
    // handed out must find NOTHING to reuse, so `POST /sessions/warm` falls
    // through to `createProjectSession` and returns a brand-new session with
    // `reused: false` — never the excluded one. Asserted here at the DB
    // layer: `existing === null` is precisely the condition the route
    // branches on (`if (existing) { reuse } else { create }`), and that
    // branch's wiring is covered separately by
    // `../projects/routes/warm-sessions.test.ts`.
    const sessionId = await seedWarmSession();

    const found = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: USER,
      excludeSessionId: sessionId,
    });

    expect(found).toBeNull();
  });

  test('excluding one warm session still finds a DIFFERENT live warm session for the same user', async () => {
    const older = await seedWarmSession({ createdAt: new Date(Date.now() - 60_000) });
    const justTaken = await seedWarmSession();

    const found = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: USER,
      excludeSessionId: justTaken,
    });

    expect(found?.sessionId).toBe(older);
  });

  test('a stopped session is never returned as warm, excluded or not', async () => {
    await seedWarmSession({ status: 'stopped' });

    const found = await findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER });

    expect(found).toBeNull();
  });

  test('a non-warm session (no metadata.warm marker) is never returned', async () => {
    await seedWarmSession({ warm: false });

    const found = await findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER });

    expect(found).toBeNull();
  });

  test("scoped to the caller — a different user's warm session is invisible regardless of exclusion", async () => {
    const otherUsersSession = await seedWarmSession({ createdBy: OTHER_USER });

    const found = await findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER });

    expect(found).toBeNull();
    // Sanity: the row really exists, scoped to its own owner.
    const foundForOwner = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: OTHER_USER,
    });
    expect(foundForOwner?.sessionId).toBe(otherUsersSession);
  });

  test('excluding an id that matches nothing is a no-op — the live warm session is still found', async () => {
    const sessionId = await seedWarmSession();

    const found = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: USER,
      excludeSessionId: crypto.randomUUID(),
    });

    expect(found?.sessionId).toBe(sessionId);
  });
});
