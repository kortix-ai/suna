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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../lib/config';
import { findWarmProjectSession, warmSessionPlacement } from '../projects/routes/warm-sessions';
import { db } from '../lib/db';
import { WARM_SESSION_LOCATION_KEY } from '../services/sessions/warm-sessions';

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
    /** Stamp the session's sandbox row with this API instance id. */
    boxInstanceId?: string;
    boxRegion?: string | null;
    boxStatus?: 'active' | 'provisioning';
    boxProvider?: 'platinum' | 'daytona';
    requestedLocation?: string;
    noSandbox?: boolean;
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
    metadata: overrides.warm === false ? {} : {
      warm: true,
      ...(overrides.requestedLocation ? { [WARM_SESSION_LOCATION_KEY]: overrides.requestedLocation } : {}),
    },
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
  if (!overrides.noSandbox) {
    await db.insert(sessionSandboxes).values({
      sandboxId: crypto.randomUUID(),
      sessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      provider: overrides.boxProvider ?? 'platinum',
      status: overrides.boxStatus ?? 'active',
      metadata: {
        ...(overrides.boxInstanceId ? { instanceId: overrides.boxInstanceId } : {}),
        ...((overrides.boxRegion === undefined ? 'eu-west' : overrides.boxRegion)
          ? { platinumRegion: overrides.boxRegion ?? 'eu-west' }
          : {}),
      },
    });
  }
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
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, ACCOUNT));
  await db.delete(projectSessions).where(eq(projectSessions.accountId, ACCOUNT));
});

describe('findWarmProjectSession — exclusion', () => {
  // Ordinary reuse with no exclusion is the owner lookup at the end of the
  // caller-scope test below.
  test('the excluded id is never returned even though its warm marker is still set', async () => {
    const sessionId = await seedWarmSession();

    const found = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: USER,
      projectMetadata: {},
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
      projectMetadata: {},
      excludeSessionId: justTaken,
    });

    expect(found?.sessionId).toBe(older);
  });

  test('a stopped session is never returned as warm', async () => {
    await seedWarmSession({ status: 'stopped' });

    const found = await findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER, projectMetadata: {} });

    expect(found).toBeNull();
  });

  test('a non-warm session (no metadata.warm marker) is never returned', async () => {
    await seedWarmSession({ warm: false });

    const found = await findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER, projectMetadata: {} });

    expect(found).toBeNull();
  });

  test("scoped to the caller — a different user's warm session is invisible regardless of exclusion", async () => {
    const otherUsersSession = await seedWarmSession({ createdBy: OTHER_USER });

    const found = await findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER, projectMetadata: {} });

    expect(found).toBeNull();
    // Sanity: the row really exists, scoped to its own owner.
    const foundForOwner = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: OTHER_USER,
      projectMetadata: {},
    });
    expect(foundForOwner?.sessionId).toBe(otherUsersSession);
  });

  test('excluding an id that matches nothing is a no-op — the live warm session is still found', async () => {
    const sessionId = await seedWarmSession();

    const found = await findWarmProjectSession({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: USER,
      projectMetadata: {},
      excludeSessionId: crypto.randomUUID(),
    });

    expect(found?.sessionId).toBe(sessionId);
  });
});

// Several local API instances share one database. The lifecycle drain refuses a
// command whose sandbox another instance provisioned (`claimDueLifecycleCommands`),
// so a warm session handed out across that line accepts a first prompt that no
// worker can ever deliver.
describe('findWarmProjectSession — instance scope', () => {
  const original = config.KORTIX_INSTANCE_ID;
  const lookup = () => findWarmProjectSession({ accountId: ACCOUNT, projectId: PROJECT, userId: USER, projectMetadata: {} });
  afterEach(() => {
    config.KORTIX_INSTANCE_ID = original;
  });

  test("another instance's warm session is never returned", async () => {
    config.KORTIX_INSTANCE_ID = 'warm-owner-test';
    await seedWarmSession({ boxInstanceId: 'warm-peer-test' });

    expect(await lookup()).toBeNull();
  });

  test('an older warm session this instance owns is returned instead', async () => {
    config.KORTIX_INSTANCE_ID = 'warm-owner-test';
    const mine = await seedWarmSession({
      boxInstanceId: 'warm-owner-test',
      createdAt: new Date(Date.now() - 60_000),
    });
    await seedWarmSession({ boxInstanceId: 'warm-peer-test' });

    expect((await lookup())?.sessionId).toBe(mine);
  });

  test('with no instance id configured every warm session is eligible', async () => {
    config.KORTIX_INSTANCE_ID = undefined;
    const sessionId = await seedWarmSession({ boxInstanceId: 'warm-peer-test' });

    expect((await lookup())?.sessionId).toBe(sessionId);
  });
});

describe('warm sessions — compute placement', () => {
  const on = { experimental: { us_region: true } };
  let originalRegion: string | undefined;
  let originalKey: typeof config.PLATINUM_API_KEY;
  beforeEach(() => {
    originalRegion = process.env.KORTIX_PLATINUM_US_REGION;
    originalKey = config.PLATINUM_API_KEY;
    process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
    config.PLATINUM_API_KEY = 'pt_test_placement';
  });
  afterEach(() => {
    if (originalRegion === undefined) delete process.env.KORTIX_PLATINUM_US_REGION;
    else process.env.KORTIX_PLATINUM_US_REGION = originalRegion;
    config.PLATINUM_API_KEY = originalKey;
  });
  const lookup = (projectMetadata: unknown = on, includeProvisioning = false) => findWarmProjectSession({
    accountId: ACCOUNT, projectId: PROJECT, userId: USER, projectMetadata, includeProvisioning,
  });

  for (const placement of ['actual', 'pending'] as const) {
    test(`${placement} US warming remains scoped to account, project, and creator`, async () => {
      const sessionId = await seedWarmSession(
        placement === 'actual'
          ? { boxRegion: 'us-east' }
          : { status: 'provisioning', boxStatus: 'provisioning', boxRegion: null, requestedLocation: 'us-east' },
      );
      for (const dimension of ['accountId', 'projectId', 'userId'] as const) {
        const scope = {
          accountId: ACCOUNT, projectId: PROJECT, userId: USER, projectMetadata: on, includeProvisioning: true,
        };
        scope[dimension] = crypto.randomUUID();
        expect(await findWarmProjectSession(scope)).toBeNull();
      }
      expect((await lookup(on, true))?.sessionId).toBe(sessionId);
    });
  }

  test('selects an older actual US box rather than newer EU or unknown candidates without changing them', async () => {
    const us = await seedWarmSession({ boxRegion: 'us-east', createdAt: new Date(Date.now() - 60_000) });
    const eu = await seedWarmSession({ boxRegion: 'eu-west' });
    const unknown = await seedWarmSession({ boxRegion: null });
    expect((await lookup())?.sessionId).toBe(us);
    expect(await warmSessionPlacement(us, on)).toBe('compatible');
    expect(await warmSessionPlacement(eu, on)).toBe('mismatch');
    expect(await warmSessionPlacement(unknown, on)).toBe('mismatch');
    const boxes = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.accountId, ACCOUNT));
    expect(boxes.find((box) => box.sessionId === eu)?.metadata).toEqual({ platinumRegion: 'eu-west' });
    expect(boxes.find((box) => box.sessionId === unknown)?.status).toBe('active');
  });

  test('unknown provisioning placement stays pending and becomes selectable only after actual region arrives', async () => {
    const sessionId = await seedWarmSession({
      status: 'provisioning', boxStatus: 'provisioning', boxRegion: null, requestedLocation: 'us-east',
    });
    expect(await lookup()).toBeNull();
    expect(await warmSessionPlacement(sessionId, on)).toBe('pending');
    // Repeated /warm requests deduplicate this in-flight create, while claims
    // still require actual placement and /start remains honestly pending.
    expect((await lookup(on, true))?.sessionId).toBe(sessionId);
    await db.update(sessionSandboxes).set({
      status: 'active', metadata: { platinumRegion: 'us-east' },
    }).where(eq(sessionSandboxes.sessionId, sessionId));
    expect((await lookup())?.sessionId).toBe(sessionId);
    expect(await warmSessionPlacement(sessionId, on)).toBe('compatible');
  });

  test('an actual EU provisioning box is a mismatch, not a pending US box', async () => {
    const sessionId = await seedWarmSession({
      status: 'provisioning', boxStatus: 'provisioning', boxRegion: 'eu-west', requestedLocation: 'us-east',
    });
    expect(await lookup()).toBeNull();
    expect(await lookup(on, true)).toBeNull();
    expect(await warmSessionPlacement(sessionId, on)).toBe('mismatch');
  });

  test('a session with no sandbox row is not selected as US', async () => {
    const sessionId = await seedWarmSession({ status: 'queued', noSandbox: true, requestedLocation: 'us-east' });
    expect(await lookup()).toBeNull();
    expect(await warmSessionPlacement(sessionId, on)).toBe('pending');
    expect((await lookup(on, true))?.sessionId).toBe(sessionId);
  });

  test('another provider cannot prove Platinum placement with a same-named metadata field', async () => {
    const sessionId = await seedWarmSession({ boxProvider: 'daytona', boxRegion: 'us-east' });
    expect(await lookup()).toBeNull();
    expect(await warmSessionPlacement(sessionId, on)).toBe('mismatch');
  });

  test('flag off preserves home-path warm reuse without demanding US placement', async () => {
    const sessionId = await seedWarmSession({ boxRegion: 'eu-west' });
    const off = { experimental: { us_region: false } };
    expect((await lookup(off))?.sessionId).toBe(sessionId);
    expect(await warmSessionPlacement(sessionId, off)).toBe('compatible');
  });

  test('US warming cannot reuse unknown legacy provisioning intent or a queued home create', async () => {
    const legacy = await seedWarmSession({ status: 'provisioning', boxStatus: 'provisioning', boxRegion: null });
    const home = await seedWarmSession({ status: 'queued', noSandbox: true, requestedLocation: 'home' });
    expect(await lookup(on, true)).toBeNull();
    expect(await warmSessionPlacement(legacy, on)).toBe('mismatch');
    expect(await warmSessionPlacement(home, on)).toBe('mismatch');
  });

  test('flag OFF/default skips actual US and unknown US-intent boxes after a flag flip', async () => {
    const home = await seedWarmSession({ boxRegion: 'eu-west', createdAt: new Date(Date.now() - 60_000) });
    const us = await seedWarmSession({ boxRegion: 'us-east' });
    const pendingUs = await seedWarmSession({
      status: 'provisioning', boxStatus: 'provisioning', boxRegion: null, requestedLocation: 'us-east',
    });
    for (const metadata of [{ experimental: { us_region: false } }, {}]) {
      expect((await lookup(metadata))?.sessionId).toBe(home);
      expect((await lookup(metadata, true))?.sessionId).toBe(home);
      expect(await warmSessionPlacement(us, metadata)).toBe('mismatch');
      expect(await warmSessionPlacement(pendingUs, metadata)).toBe('mismatch');
    }
  });

  test('home warming deduplicates trusted home intent without claiming unknown placement', async () => {
    const off = { experimental: { us_region: false } };
    const sessionId = await seedWarmSession({
      status: 'branching', noSandbox: true, requestedLocation: 'home',
    });
    expect((await lookup(off, true))?.sessionId).toBe(sessionId);
    expect(await lookup(off)).toBeNull();
    expect(await warmSessionPlacement(sessionId, off)).toBe('pending');
  });
});
