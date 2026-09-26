// Compute metering against a real PostgreSQL: the windows it opens in
// `sandbox_compute_sessions`, the candidate SQL of its reconcile sweeps, and the
// `compute_debit` rows the real wallet writes to `credit_ledger`. Only the
// provider (the network boundary) is faked.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  appArtifacts,
  appDeployments,
  appRuntimes,
  apps,
  creditAccounts,
  creditLedger,
  projectMonitorBoxes,
  sandboxComputeSessions,
  sessionSandboxes,
} from '@kortix/db';
import { asc, eq, sql } from 'drizzle-orm';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

// Metering is a managed-deployment feature. `apps/api/src/config` validates the
// environment at import time, so billing, and the keys a managed deployment must
// hold, are set before the first API import. No value is reachable.
Object.assign(process.env, {
  KORTIX_BILLING_INTERNAL_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_compute_metering',
  STRIPE_WEBHOOK_SECRET: 'whsec_compute_metering',
  KORTIX_URL: 'http://127.0.0.1:1',
  DAYTONA_API_KEY: 'compute-metering-test',
  DAYTONA_SERVER_URL: 'http://127.0.0.1:1',
  DAYTONA_TARGET: 'us',
});

/** Provider status per external id; an Error makes the probe throw. */
let providerStatus: Record<string, string | Error> = {};
/** External ids the sweeps probed, in probe order. */
let probed: string[] = [];

const realProviders = await import('../../platform/providers');
mock.module('../../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    getStatus: async (externalId: string) => {
      probed.push(externalId);
      const status = providerStatus[externalId] ?? 'running';
      if (status instanceof Error) throw status;
      return status;
    },
  }),
}));

const { db } = await import('../../shared/db');
const fixtures = await import('../../__tests__/helpers/integration-fixtures');
const {
  endComputeSession,
  markComputeSessionAlive,
  pauseComputeSession,
  reconcileMissingAppComputeSessions,
  reconcileMissingComputeSessions,
  reopenComputeForSandbox,
  startComputeSession,
  tickRunningComputeCharges,
} = await import('./compute-metering');
const { countBillingInvariantViolations, countStaleLivenessWindows, reconcileOrphanComputeSessions } =
  await import('./compute-invariant-sweep');

const SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };
/** 2 vCPU / 4 GB / 20 GB for one hour, at list price. */
const HOURLY = 0.201312;
const MINUTE = 60_000;
const USER = '00000000-0000-4000-a000-000000009d01';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function account(credit: { billingModel?: string; tier?: string | null } | null): Promise<string> {
  const accountId = await fixtures.seedAccount('compute-metering');
  if (credit) {
    await db.insert(creditAccounts).values({
      accountId,
      billingModel: credit.billingModel ?? 'per_seat',
      tier: credit.tier === undefined ? 'free' : credit.tier,
      balance: '100',
      nonExpiringCredits: '100',
    });
  }
  return accountId;
}

async function sandbox(
  accountId: string,
  options: { status?: 'active' | 'stopped'; externalId?: string | null; createdAt?: string } = {},
): Promise<string> {
  const project = await fixtures.seedProject('compute-metering', { accountId });
  const sessionId = await fixtures.seedSession(project, USER);
  const sandboxId = crypto.randomUUID();
  await db.insert(sessionSandboxes).values({
    sandboxId,
    sessionId,
    accountId,
    projectId: project.project_id,
    provider: 'daytona',
    externalId: options.externalId === undefined ? `ext-${sandboxId}` : options.externalId,
    status: options.status ?? 'active',
    ...(options.createdAt ? { createdAt: new Date(options.createdAt) } : {}),
  });
  return sandboxId;
}

/** An open window written directly, for states the service reaches only over time. */
async function openWindow(input: {
  accountId: string;
  sandboxId?: string;
  startedAt: string;
  lastBilledAt?: string;
  metadata?: Record<string, unknown>;
  workloadType?: 'session' | 'app' | 'monitor';
  appRuntimeId?: string;
}): Promise<{ id: string; sandboxId: string }> {
  const sandboxId = input.sandboxId ?? crypto.randomUUID();
  const [row] = await db
    .insert(sandboxComputeSessions)
    .values({
      accountId: input.accountId,
      sandboxId,
      provider: 'daytona',
      ...SPEC,
      state: 'active',
      startedAt: input.startedAt,
      lastBilledAt: input.lastBilledAt ?? input.startedAt,
      metadata: input.metadata ?? {},
      workloadType: input.workloadType ?? 'session',
      appRuntimeId: input.appRuntimeId ?? null,
    })
    .returning({ id: sandboxComputeSessions.id });
  return { id: row!.id, sandboxId };
}

async function windowsOf(sandboxId: string) {
  const rows = await db
    .select()
    .from(sandboxComputeSessions)
    .where(eq(sandboxComputeSessions.sandboxId, sandboxId))
    .orderBy(asc(sandboxComputeSessions.createdAt));
  return rows.map((row) => ({
    ...row,
    startedAt: iso(Date.parse(row.startedAt)),
    lastBilledAt: iso(Date.parse(row.lastBilledAt)),
    endedAt: row.endedAt === null ? null : iso(Date.parse(row.endedAt)),
    costUsd: Number(row.costUsd),
  }));
}

async function ledgerOf(accountId: string) {
  const rows = await db
    .select({
      type: creditLedger.type,
      amount: creditLedger.amount,
      description: creditLedger.description,
      idempotencyKey: creditLedger.idempotencyKey,
      metadata: creditLedger.metadata,
    })
    .from(creditLedger)
    .where(eq(creditLedger.accountId, accountId));
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function backdate(sandboxId: string, startedAt: string, lastBilledAt = startedAt) {
  await db
    .update(sandboxComputeSessions)
    .set({ startedAt, lastBilledAt })
    .where(eq(sandboxComputeSessions.sandboxId, sandboxId));
}

let appSeq = 0;
/** An App with its artifact, one deployment, and one runtime. */
async function app(
  accountId: string,
  options: {
    runtimeStatus?: 'running' | 'stopped';
    activeDeployment?: boolean;
    desiredState?: 'running' | 'stopped';
    deleted?: boolean;
    spec?: { cpuCores: number; memoryGb: number; diskGb: number };
  } = {},
) {
  appSeq += 1;
  const project = await fixtures.seedProject(`compute-app-${appSeq}`, { accountId });
  const [created] = await db
    .insert(apps)
    .values({
      accountId,
      projectId: project.project_id,
      slug: `metered-${appSeq}`,
      name: `Metered ${appSeq}`,
      routeKey: `cm${Date.now().toString(36)}${appSeq}`.slice(0, 20),
      desiredState: options.desiredState ?? 'running',
      ...(options.spec ?? {}),
      ...(options.deleted ? { deletedAt: new Date() } : {}),
    })
    .returning({ appId: apps.appId });
  const [artifact] = await db
    .insert(appArtifacts)
    .values({
      accountId,
      projectId: project.project_id,
      kind: 'oci_image',
      status: 'ready',
      imageReference: 'registry.example.test/app:1',
    })
    .returning({ artifactId: appArtifacts.artifactId });
  const [deployment] = await db
    .insert(appDeployments)
    .values({
      appId: created!.appId,
      artifactId: artifact!.artifactId,
      version: 1,
      status: 'ready',
      sourceKind: 'oci_image',
      runtimeVersion: 'test',
      createdBy: USER,
    })
    .returning({ deploymentId: appDeployments.deploymentId });
  const externalId = `app-ext-${appSeq}`;
  const [runtime] = await db
    .insert(appRuntimes)
    .values({
      deploymentId: deployment!.deploymentId,
      accountId,
      provider: 'daytona',
      externalId,
      status: options.runtimeStatus ?? 'running',
      controlTokenHash: '0'.repeat(64),
    })
    .returning({ runtimeId: appRuntimes.runtimeId });
  if (options.activeDeployment !== false) {
    await db
      .update(apps)
      .set({ activeDeploymentId: deployment!.deploymentId })
      .where(eq(apps.appId, created!.appId));
  }
  return {
    appId: created!.appId,
    deploymentId: deployment!.deploymentId,
    runtimeId: runtime!.runtimeId,
    externalId,
    projectId: project.project_id,
  };
}

withDb('compute metering on PostgreSQL', () => {
  beforeEach(async () => {
    providerStatus = {};
    probed = [];
    // The tick and the sweeps read every open window and every active sandbox,
    // so each test starts with none. A sandbox identity cannot be deleted
    // (kortix.guard_session_sandbox_identity), so earlier ones are stopped.
    await db.execute(sql`delete from kortix.sandbox_compute_sessions`);
    await db.execute(sql`update kortix.session_sandboxes set status = 'stopped' where status <> 'stopped'`);
    await db.execute(sql`update kortix.apps set active_deployment_id = null`);
    await db.execute(sql`delete from kortix.app_runtimes`);
    await db.execute(sql`delete from kortix.app_deployments`);
    await db.execute(sql`delete from kortix.apps`);
    await db.execute(sql`delete from kortix.app_artifacts`);
    await db.execute(sql`delete from kortix.project_monitor_boxes`);
  });

  describe('a window opens, settles, and closes', () => {
    test('start opens one active window with its cursor at its start and moves no credit', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = await sandbox(accountId);

      const id = await startComputeSession({ sandboxId, accountId, provider: 'e2b', spec: SPEC });

      const [open] = await windowsOf(sandboxId);
      expect(open).toMatchObject({ id, state: 'active', endedAt: null, provider: 'e2b', costUsd: 0 });
      expect(open!.lastBilledAt).toBe(open!.startedAt);
      expect(await ledgerOf(accountId)).toEqual([]);
    });

    test('a second start for the same sandbox returns the open window', async () => {
      const accountId = await account({ billingModel: 'credit' });
      const sandboxId = await sandbox(accountId);

      const first = await startComputeSession({ sandboxId, accountId, spec: SPEC });
      const second = await startComputeSession({ sandboxId, accountId, spec: SPEC });

      expect(second).toBe(first);
      expect(await windowsOf(sandboxId)).toHaveLength(1);
    });

    test('a legacy paid plan opens no window', async () => {
      const accountId = await account({ billingModel: 'legacy', tier: 'tier_6_50' });
      const sandboxId = await sandbox(accountId);

      expect(await startComputeSession({ sandboxId, accountId, spec: SPEC })).toBeNull();
      expect(await windowsOf(sandboxId)).toEqual([]);
    });

    test('pause stops the window and settles one compute_debit keyed on the window end', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = await sandbox(accountId);
      const id = await startComputeSession({ sandboxId, accountId, spec: SPEC });
      const start = Math.floor(Date.now() / 1000) * 1000 - 10 * MINUTE;
      await backdate(sandboxId, iso(start));

      await pauseComputeSession(sandboxId, new Date(start + 300_000));

      const end = iso(start + 300_000);
      expect(await windowsOf(sandboxId)).toEqual([
        expect.objectContaining({ id, state: 'stopped', endedAt: end, lastBilledAt: end, costUsd: 0.016776 }),
      ]);
      expect(await ledgerOf(accountId)).toEqual([
        {
          type: 'usage',
          amount: -0.016776,
          description: 'Sandbox compute · 2vCPU/4GB/20GB · 300s',
          idempotencyKey: `compute:${id}:${end}`,
          metadata: expect.objectContaining({ ledger_type: 'compute_debit' }),
        },
      ]);
    });

    test('end finalizes the window and settles it', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = await sandbox(accountId);
      await startComputeSession({ sandboxId, accountId, spec: SPEC });
      await backdate(sandboxId, iso(Date.now() - MINUTE));

      await endComputeSession(sandboxId);

      const [closed] = await windowsOf(sandboxId);
      expect(closed).toMatchObject({ state: 'finalized' });
      expect(closed!.endedAt).toBe(closed!.lastBilledAt);
      const ledger = await ledgerOf(accountId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.amount).toBeCloseTo(-HOURLY / 60, 4);
    });

    // Stop, hibernate, and delete paths call pause/end best-effort, often for a
    // sandbox that never opened a window or whose window is already closed.
    test('pause and end of a sandbox without an open window write nothing', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = await sandbox(accountId);

      await expect(pauseComputeSession(sandboxId)).resolves.toBeUndefined();
      await expect(endComputeSession(sandboxId)).resolves.toBeUndefined();

      expect(await windowsOf(sandboxId)).toEqual([]);
      expect(await ledgerOf(accountId)).toEqual([]);
    });

    test('two concurrent closes settle one window and close it at its own cursor', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = await sandbox(accountId);
      await startComputeSession({ sandboxId, accountId, spec: SPEC });
      const start = Math.floor(Date.now() / 1000) * 1000 - 10 * MINUTE;
      await backdate(sandboxId, iso(start));

      await Promise.all([
        pauseComputeSession(sandboxId, new Date(start + MINUTE)),
        pauseComputeSession(sandboxId, new Date(start + 2 * MINUTE)),
      ]);

      const [closed] = await windowsOf(sandboxId);
      expect([iso(start + MINUTE), iso(start + 2 * MINUTE)]).toContain(closed!.endedAt!);
      expect(closed!.lastBilledAt).toBe(closed!.endedAt!);
      const ledger = await ledgerOf(accountId);
      expect(ledger).toHaveLength(1);
      const billedMinutes = (Date.parse(closed!.endedAt!) - start) / MINUTE;
      expect(ledger[0]!.amount).toBeCloseTo((-HOURLY / 60) * billedMinutes, 6);
    });

    test('a reopened sandbox gets a new window at its last spec and provider', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = await sandbox(accountId);
      const first = await startComputeSession({
        sandboxId,
        accountId,
        provider: 'e2b',
        spec: { cpuCores: 4, memoryGb: 8, diskGb: 40, gpuCount: 0 },
      });
      await pauseComputeSession(sandboxId);

      const second = await reopenComputeForSandbox(sandboxId, accountId, null, null, 'daytona');

      expect(second).not.toBe(first);
      expect(await windowsOf(sandboxId)).toEqual([
        expect.objectContaining({ id: first, state: 'stopped' }),
        expect.objectContaining({
          id: second,
          state: 'active',
          endedAt: null,
          provider: 'e2b',
          cpuCores: 4,
          memoryGb: 8,
          diskGb: 40,
        }),
      ]);
    });
  });

  describe('settlement is bounded by evidence and by the cursor', () => {
    test('a window never observed alive bills only the grace past its start', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const start = Date.now() - 10 * 60 * MINUTE;
      const window = await openWindow({ accountId, startedAt: iso(start) });

      await tickRunningComputeCharges();

      const [row] = await windowsOf(window.sandboxId);
      expect(row).toMatchObject({ state: 'active', endedAt: null, lastBilledAt: iso(start + 60 * MINUTE) });
      const ledger = await ledgerOf(accountId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.amount).toBeCloseTo(-HOURLY, 6);
    });

    // The cursor can sit past the grace after an earlier settle. A partial
    // settle there has no window: the cursor must not move back to the grace.
    test('a window already billed past its grace settles nothing and keeps its cursor', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const start = Date.now() - 10 * 60 * MINUTE;
      const window = await openWindow({ accountId, startedAt: iso(start), lastBilledAt: iso(start + 90 * MINUTE) });

      await tickRunningComputeCharges();

      expect(await windowsOf(window.sandboxId)).toEqual([
        expect.objectContaining({ state: 'active', lastBilledAt: iso(start + 90 * MINUTE), costUsd: 0 }),
      ]);
      expect(await ledgerOf(accountId)).toEqual([]);
    });

    test('a close evidenced before the cursor closes at the cursor and charges nothing', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const start = Date.now() - 30 * MINUTE;
      const window = await openWindow({ accountId, startedAt: iso(start), lastBilledAt: iso(start + 20 * MINUTE) });

      await pauseComputeSession(window.sandboxId, new Date(start + 10 * MINUTE));

      expect(await windowsOf(window.sandboxId)).toEqual([
        expect.objectContaining({
          state: 'stopped',
          endedAt: iso(start + 20 * MINUTE),
          lastBilledAt: iso(start + 20 * MINUTE),
        }),
      ]);
      expect(await ledgerOf(accountId)).toEqual([]);
    });

    test('a settlement the wallet refuses gives the window back, partial and terminal', async () => {
      const accountId = await account(null);
      const start = Date.now() - 10 * MINUTE;
      const window = await openWindow({ accountId, startedAt: iso(start) });

      await tickRunningComputeCharges();
      expect(await windowsOf(window.sandboxId)).toEqual([
        expect.objectContaining({ state: 'active', endedAt: null, lastBilledAt: iso(start), costUsd: 0 }),
      ]);

      await pauseComputeSession(window.sandboxId);
      expect(await windowsOf(window.sandboxId)).toEqual([
        expect.objectContaining({ state: 'active', endedAt: null, lastBilledAt: iso(start), costUsd: 0 }),
      ]);
      expect(await ledgerOf(accountId)).toEqual([]);
    });

    test('an observation of a live box extends only its open window', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = crypto.randomUUID();
      const closed = await openWindow({ accountId, sandboxId, startedAt: iso(Date.now() - 60 * MINUTE) });
      await db
        .update(sandboxComputeSessions)
        .set({ endedAt: iso(Date.now() - 30 * MINUTE), state: 'stopped' })
        .where(eq(sandboxComputeSessions.id, closed.id));
      await openWindow({ accountId, sandboxId, startedAt: iso(Date.now() - 10 * MINUTE), metadata: { appId: 'a' } });
      const at = new Date();

      await markComputeSessionAlive(sandboxId, at);

      expect((await windowsOf(sandboxId)).map((row) => row.metadata)).toEqual([
        {},
        { appId: 'a', lastAliveAt: at.toISOString() },
      ]);
    });
  });

  describe('the maintenance tick', () => {
    test('settles a window older than one maintenance interval without closing it', async () => {
      const due = await account({ billingModel: 'per_seat' });
      const fresh = await account({ billingModel: 'per_seat' });
      const dueWindow = await openWindow({ accountId: due, startedAt: iso(Date.now() - 6 * MINUTE) });
      const freshStart = iso(Date.now() - 4 * MINUTE);
      const freshWindow = await openWindow({ accountId: fresh, startedAt: freshStart });

      const result = await tickRunningComputeCharges();

      expect(result.settled).toBe(1);
      const [settled] = await windowsOf(dueWindow.sandboxId);
      expect(settled).toMatchObject({ state: 'active', endedAt: null });
      expect(settled!.costUsd).toBeGreaterThan(0);
      expect(await ledgerOf(due)).toHaveLength(1);
      expect(await windowsOf(freshWindow.sandboxId)).toEqual([
        expect.objectContaining({ lastBilledAt: freshStart, costUsd: 0 }),
      ]);
      expect(await ledgerOf(fresh)).toEqual([]);
    });

    test('opens a missing window in the same pass', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const sandboxId = await sandbox(accountId);

      expect(await tickRunningComputeCharges()).toEqual({ settled: 0, reconciled: 1 });
      expect(await windowsOf(sandboxId)).toEqual([expect.objectContaining({ state: 'active', endedAt: null })]);
    });
  });

  describe('the missing-window sweep', () => {
    test('meters every account that pays for compute and skips legacy paid plans', async () => {
      const metered = {
        perSeat: await sandbox(await account({ billingModel: 'per_seat' }), { externalId: 'per-seat' }),
        credit: await sandbox(await account({ billingModel: 'credit' }), { externalId: 'credit' }),
        legacyFree: await sandbox(await account({ billingModel: 'legacy', tier: 'free' }), {
          externalId: 'legacy-free',
        }),
        legacyNoTier: await sandbox(await account({ billingModel: 'legacy', tier: null }), {
          externalId: 'legacy-no-tier',
        }),
      };
      await sandbox(await account({ billingModel: 'legacy', tier: 'tier_2_20' }), { externalId: 'legacy-tier-2-20' });
      await sandbox(await account({ billingModel: 'legacy', tier: 'pro' }), { externalId: 'legacy-pro' });
      await sandbox(await account(null), { externalId: 'no-credit-row' });

      const result = await reconcileMissingComputeSessions();

      expect(result).toEqual({ checked: 4, reconciled: 4, errors: 0 });
      expect(probed.sort()).toEqual(['credit', 'legacy-free', 'legacy-no-tier', 'per-seat']);
      for (const sandboxId of Object.values(metered)) {
        expect(await windowsOf(sandboxId)).toEqual([expect.objectContaining({ state: 'active' })]);
      }
    });

    test('only an active sandbox without an open window is a candidate', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      await sandbox(accountId, { status: 'stopped', externalId: 'stopped' });
      const alreadyMetered = await sandbox(accountId, { externalId: 'already-metered' });
      await openWindow({ accountId, sandboxId: alreadyMetered, startedAt: iso(Date.now()) });
      const closedOnly = await sandbox(accountId, { externalId: 'closed-window' });
      const closed = await openWindow({ accountId, sandboxId: closedOnly, startedAt: iso(Date.now() - MINUTE) });
      await db
        .update(sandboxComputeSessions)
        .set({ endedAt: iso(Date.now()), state: 'stopped' })
        .where(eq(sandboxComputeSessions.id, closed.id));

      expect(await reconcileMissingComputeSessions()).toEqual({ checked: 1, reconciled: 1, errors: 0 });
      expect(probed).toEqual(['closed-window']);
    });

    test('a bounded pass takes the oldest sandboxes first', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      await sandbox(accountId, { externalId: 'newest', createdAt: iso(Date.now() - MINUTE) });
      await sandbox(accountId, { externalId: 'oldest', createdAt: iso(Date.now() - 3 * MINUTE) });
      await sandbox(accountId, { externalId: 'middle', createdAt: iso(Date.now() - 2 * MINUTE) });

      expect(await reconcileMissingComputeSessions(2)).toEqual({ checked: 2, reconciled: 2, errors: 0 });
      expect(probed).toEqual(['oldest', 'middle']);
    });

    test('a sandbox the provider cannot confirm running stays unmetered', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const noTarget = await sandbox(accountId, { externalId: null });
      const stopped = await sandbox(accountId, { externalId: 'provider-stopped' });
      providerStatus['provider-stopped'] = 'stopped';

      expect(await reconcileMissingComputeSessions()).toEqual({ checked: 2, reconciled: 0, errors: 0 });
      expect(probed).toEqual(['provider-stopped']);
      expect(await windowsOf(noTarget)).toEqual([]);
      expect(await windowsOf(stopped)).toEqual([]);
    });

    test('one failing sandbox does not stop the pass', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      await sandbox(accountId, { externalId: 'probe-fails', createdAt: iso(Date.now() - 2 * MINUTE) });
      const healthy = await sandbox(accountId, { externalId: 'healthy', createdAt: iso(Date.now() - MINUTE) });
      providerStatus['probe-fails'] = new Error('provider unreachable');

      expect(await reconcileMissingComputeSessions()).toEqual({ checked: 2, reconciled: 1, errors: 1 });
      expect(await windowsOf(healthy)).toHaveLength(1);
    });
  });

  describe('the missing-window sweep for Apps', () => {
    test('meters only the running runtime of the active deployment of a running, live App', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const billable = await app(accountId);
      await app(accountId, { runtimeStatus: 'stopped' });
      await app(accountId, { activeDeployment: false });
      await app(accountId, { desiredState: 'stopped' });
      await app(accountId, { deleted: true });
      await app(await account({ billingModel: 'legacy', tier: 'tier_6_50' }));
      const metered = await app(accountId);
      await openWindow({
        accountId,
        sandboxId: metered.runtimeId,
        startedAt: iso(Date.now()),
        workloadType: 'app',
        appRuntimeId: metered.runtimeId,
      });

      expect(await reconcileMissingAppComputeSessions()).toEqual({ checked: 1, reconciled: 1, errors: 0 });
      expect(probed).toEqual([billable.externalId]);
    });

    test('an App window carries the App machine and its attribution', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const billable = await app(accountId, { spec: { cpuCores: 4, memoryGb: 8, diskGb: 40 } });

      await reconcileMissingAppComputeSessions();

      expect(await windowsOf(billable.runtimeId)).toEqual([
        expect.objectContaining({
          workloadType: 'app',
          appRuntimeId: billable.runtimeId,
          cpuCores: 4,
          memoryGb: 8,
          diskGb: 40,
          metadata: { appId: billable.appId, deploymentId: billable.deploymentId, reconciled: true },
        }),
      ]);
    });

    test('a runtime the provider reports stopped stays unmetered', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const billable = await app(accountId);
      providerStatus[billable.externalId] = 'stopped';

      expect(await reconcileMissingAppComputeSessions()).toEqual({ checked: 1, reconciled: 0, errors: 0 });
      expect(await windowsOf(billable.runtimeId)).toEqual([]);
    });
  });

  describe('the billing invariant', () => {
    test('the sweep keeps session, App, and monitor windows of live boxes open and closes an orphan', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const now = Date.now();
      const sessionBox = await sandbox(accountId);
      const session = await openWindow({ accountId, sandboxId: sessionBox, startedAt: iso(now - MINUTE) });
      const runningApp = await app(accountId);
      const appWindow = await openWindow({
        accountId,
        sandboxId: runningApp.runtimeId,
        startedAt: iso(now - MINUTE),
        workloadType: 'app',
        appRuntimeId: runningApp.runtimeId,
      });
      const monitorProject = await fixtures.seedProject('compute-monitor', { accountId });
      const [box] = await db
        .insert(projectMonitorBoxes)
        .values({
          projectId: monitorProject.project_id,
          accountId,
          provider: 'daytona',
          externalId: 'monitor-ext',
          status: 'running',
          boxEpoch: 'epoch-1',
        })
        .returning({ boxId: projectMonitorBoxes.boxId });
      const monitor = await openWindow({
        accountId,
        sandboxId: box!.boxId,
        startedAt: iso(now - MINUTE),
        workloadType: 'monitor',
      });
      const orphan = await openWindow({ accountId, startedAt: iso(now - 10 * MINUTE) });

      const result = await reconcileOrphanComputeSessions(new Date(now));

      expect(result).toMatchObject({ checked: 4, closed: 1, errors: 0 });
      expect(result.byReason['sandbox-row-missing']).toBe(1);
      for (const open of [session, appWindow, monitor]) {
        expect(await windowsOf(open.sandboxId)).toEqual([expect.objectContaining({ endedAt: null })]);
      }
      expect(await windowsOf(orphan.sandboxId)).toEqual([expect.objectContaining({ state: 'stopped' })]);
    });

    test('the monitors count open windows of dead boxes and live boxes not observed inside the grace', async () => {
      const accountId = await account({ billingModel: 'per_seat' });
      const now = Date.now();
      const stoppedBox = await sandbox(accountId, { status: 'stopped' });
      await openWindow({ accountId, sandboxId: stoppedBox, startedAt: iso(now - MINUTE) });
      const unobserved = await sandbox(accountId);
      await openWindow({ accountId, sandboxId: unobserved, startedAt: iso(now - 2 * 60 * MINUTE) });
      const observed = await sandbox(accountId);
      await openWindow({
        accountId,
        sandboxId: observed,
        startedAt: iso(now - 2 * 60 * MINUTE),
        metadata: { lastAliveAt: iso(now - MINUTE) },
      });

      expect(await countBillingInvariantViolations()).toBe(1);
      expect(await countStaleLivenessWindows(new Date(now))).toBe(1);
    });
  });
});
