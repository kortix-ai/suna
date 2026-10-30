// Compute metering with CHARGING OFF against a real PostgreSQL: the meter runs
// (windows open, accrue cost, close, reconcile) while nothing moves in any
// wallet — the billing revamp contract that metering is observability in every
// environment and only charging is gated (KRTX-1832). The provider (the
// network boundary) is faked, exactly like compute-metering.integration.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { creditAccounts, creditLedger, sandboxComputeSessions, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

// `apps/api/src/config` validates the environment at import time. This file is
// the charging-off environment: no Stripe keys are required and billing stays
// disabled for the whole file (each DB suite runs in its own process).
Object.assign(process.env, {
  KORTIX_URL: 'http://127.0.0.1:1',
  DAYTONA_API_KEY: 'compute-metering-charge-off-test',
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
  reconcileMissingComputeSessions,
  startComputeSession,
  tickRunningComputeCharges,
} = await import('./compute-metering');

const SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };
/** 2 vCPU / 4 GB / 20 GB for one hour, at list price. */
const HOURLY = 0.10944109589041096;
const TEN_MINUTES = HOURLY / 6;
const SECOND = 1_000;
const MINUTE = 60_000;
const USER = '00000000-0000-4000-a000-000000009d02';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// No credit_accounts row is seeded at all — the local/self-hosted shape: the
// account exists, charging never ran, and the meter must still record.
async function account(): Promise<string> {
  return fixtures.seedAccount('compute-metering-charge-off');
}

async function sandbox(
  accountId: string,
  options: { status?: 'active' | 'stopped'; externalId?: string | null; createdAt?: string } = {},
): Promise<string> {
  const project = await fixtures.seedProject('compute-metering-charge-off', { accountId });
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

async function windowsOf(sandboxId: string) {
  const rows = await db
    .select()
    .from(sandboxComputeSessions)
    .where(eq(sandboxComputeSessions.sandboxId, sandboxId));
  return rows.map((row) => ({ ...row, costUsd: Number(row.costUsd) }));
}

async function ledgerOf(accountId: string) {
  return db.select().from(creditLedger).where(eq(creditLedger.accountId, accountId));
}

async function creditRowCount(accountId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId));
  return row!.n;
}

beforeEach(() => {
  providerStatus = {};
  probed = [];
});

withDb('metering with charging off', () => {
  test('a provision opens a metering window with no credit_accounts row', async () => {
    const accountId = await account();
    const sandboxId = await sandbox(accountId);

    const windowId = await startComputeSession({ sandboxId, accountId, spec: SPEC });

    expect(windowId).not.toBeNull();
    const [row] = await windowsOf(sandboxId);
    expect(row!.state).toBe('active');
    expect(row!.cpuCores).toBe(SPEC.cpuCores);
    expect(row!.costUsd).toBe(0);
    expect(await creditRowCount(accountId)).toBe(0);
  });

  test('the tick accrues cost on the row and writes no ledger entry', async () => {
    const accountId = await account();
    const sandboxId = await sandbox(accountId);
    // Five extra seconds: the tick bills from the backdated cursor to its own
    // `now`, and cost_usd is numeric(12,6). A window of exactly ten minutes
    // lands within one rounding step of the TEN_MINUTES floor below — settle
    // runs are often <10ms and then the floor fails on rounding alone. Ten
    // minutes plus five seconds keeps the floor deterministic.
    const startedAt = iso(Date.now() - 10 * MINUTE - 5 * SECOND);
    const windowId = await startComputeSession({ sandboxId, accountId, spec: SPEC });
    expect(windowId).not.toBeNull();

    // The stale-window query needs a last_billed_at older than the tick
    // interval; a just-opened window is not stale yet. Backdate it directly.
    await db
      .update(sandboxComputeSessions)
      .set({ lastBilledAt: startedAt, startedAt })
      .where(eq(sandboxComputeSessions.id, windowId!));
    const accrued = await tickRunningComputeCharges();
    expect(accrued.settled).toBeGreaterThanOrEqual(1);

    const [row] = await windowsOf(sandboxId);
    // 10 min + a few wall-clock seconds of 2 vCPU / 4 GB / 20 GB at list
    // price: always past the TEN_MINUTES floor (the extra backdate), never
    // meaningfully past it (the settle runs right after the backdate).
    expect(row!.costUsd).toBeGreaterThan(TEN_MINUTES);
    expect(row!.costUsd).toBeLessThan(TEN_MINUTES + 0.001);
    // THE point: metering accrued, charging moved nothing.
    expect(await ledgerOf(accountId)).toEqual([]);
  });

  test('a pause closes the window with its cost and still writes no ledger entry', async () => {
    const accountId = await account();
    const sandboxId = await sandbox(accountId);
    const startedAt = iso(Date.now() - 5 * MINUTE);
    const windowId = await startComputeSession({ sandboxId, accountId, spec: SPEC });
    await db
      .update(sandboxComputeSessions)
      .set({ lastBilledAt: startedAt, startedAt })
      .where(eq(sandboxComputeSessions.id, windowId!));

    await pauseComputeSession(sandboxId);

    // The production stop path flips the sandbox row right after the meter
    // closes (billing first, status second) — mirror it so the sandbox does not
    // linger as a reconcile candidate for the later test in this file-DB.
    await db.update(sessionSandboxes).set({ status: 'stopped' }).where(eq(sessionSandboxes.sandboxId, sandboxId));

    const [row] = await windowsOf(sandboxId);
    expect(row!.state).toBe('stopped');
    expect(row!.endedAt).not.toBeNull();
    expect(row!.costUsd).toBeGreaterThan(0);
    expect(await ledgerOf(accountId)).toEqual([]);
  });

  test('an end finalizes the row the same way', async () => {
    const accountId = await account();
    const sandboxId = await sandbox(accountId);
    const startedAt = iso(Date.now() - 3 * MINUTE);
    const windowId = await startComputeSession({ sandboxId, accountId, spec: SPEC });
    await db
      .update(sandboxComputeSessions)
      .set({ lastBilledAt: startedAt, startedAt })
      .where(eq(sandboxComputeSessions.id, windowId!));

    await endComputeSession(sandboxId);

    // Same as pause: the delete/restart path flips the sandbox row after the
    // meter finalizes.
    await db.update(sessionSandboxes).set({ status: 'stopped' }).where(eq(sessionSandboxes.sandboxId, sandboxId));

    const [row] = await windowsOf(sandboxId);
    expect(row!.state).toBe('finalized');
    expect(row!.endedAt).not.toBeNull();
    expect(row!.costUsd).toBeGreaterThan(0);
    expect(await ledgerOf(accountId)).toEqual([]);
  });

  test('markComputeSessionAlive stamps the open window', async () => {
    const accountId = await account();
    const sandboxId = await sandbox(accountId);
    const windowId = await startComputeSession({ sandboxId, accountId, spec: SPEC });

    const at = new Date(Date.now() - 1000);
    await markComputeSessionAlive(sandboxId, at);

    const [row] = await windowsOf(sandboxId);
    expect(row!.id).toBe(windowId!);
    expect((row!.metadata as { lastAliveAt?: string }).lastAliveAt).toBe(iso(at.getTime()));
  });

  test('the reconcile sweep reopens a missing window for an account with no credit row', async () => {
    const accountId = await account();
    const sandboxId = await sandbox(accountId, { createdAt: iso(Date.now() - 2 * MINUTE) });

    const result = await reconcileMissingComputeSessions();

    expect(result).toEqual({ checked: 1, reconciled: 1, errors: 0 });
    const [row] = await windowsOf(sandboxId);
    expect(row!.state).toBe('active');
    expect(await ledgerOf(accountId)).toEqual([]);
  });
});
