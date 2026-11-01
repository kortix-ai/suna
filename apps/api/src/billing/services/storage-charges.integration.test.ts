// Storage billing against a real PostgreSQL: the storage_charges rows, the
// cursor, and the `storage_debit` rows the real wallet writes to
// credit_ledger. Only Platinum (the network boundary: the volume-usage feed
// and the volume lookup) is faked.
import { beforeEach, describe, expect, test } from 'bun:test';
import { accounts, creditAccounts, creditLedger, drives, sessionSandboxes, storageCharges } from '@kortix/db';
import { and, asc, eq, sql } from 'drizzle-orm';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

// Billing is a managed-deployment feature; config validates at import time.
Object.assign(process.env, {
  KORTIX_BILLING_INTERNAL_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_storage_charges',
  STRIPE_WEBHOOK_SECRET: 'whsec_storage_charges',
  KORTIX_URL: 'http://127.0.0.1:1',
  PLATINUM_API_KEY: 'storage-charges-test',
  PLATINUM_API_URL: 'http://127.0.0.1:1',
});

const { db } = await import('../../shared/db');
const fixtures = await import('../../__tests__/helpers/integration-fixtures');
const { invalidateAccountBilling } = await import('./billing-cache');
const storage = await import('./storage-charges');
const { syncStorageCharges, storageChargeDeps, STORAGE_CURSOR_KEY } = storage;
type Page = import('./storage-charges').PlatinumVolumeUsagePage;

const USER = '00000000-0000-4000-a000-000000005c01';
const NOW = Date.parse('2026-11-01T06:00:00.000Z');
const YESTERDAY = '2026-10-31';

/** Platinum's receipts per day, and its volume names by id. A missing name is a 404. */
let feed: Record<string, Page['resources']>;
let names: Record<string, string>;
let lookups: string[];
let failSettleOnce: string | null;

function page(day: string): Page {
  const resources = feed[day] ?? [];
  return {
    total_gib_hours: resources.reduce((sum, r) => sum + r.gib_hours, 0),
    total_metered_micros: resources.reduce((sum, r) => sum + r.metered_micros, 0),
    resources,
  };
}

const deps: import('./storage-charges').StorageChargeDeps = {
  ...storageChargeDeps,
  feeds: () => [{ name: 'home' }],
  usage: async (_feed, day) => page(day),
  volumeName: async (_feed, id) => {
    lookups.push(id);
    return names[id] ?? null;
  },
  settle: async (input) => {
    // A wallet write that lands, then the process dies before the row is finalized.
    const result = await storageChargeDeps.settle(input);
    if (failSettleOnce && input.key?.request === failSettleOnce) {
      failSettleOnce = null;
      throw new Error('process died after the wallet write');
    }
    return result;
  },
  now: () => NOW,
};

const receipt = (kind: string, id: string, gibHours: number) => ({
  resource_kind: kind,
  resource_id: id,
  gib_hours: gibHours,
  metered_micros: Math.floor(gibHours * 82),
});

async function account(label: string, overrides?: Record<string, unknown>): Promise<string> {
  const accountId = await fixtures.seedAccount(label);
  await db.insert(creditAccounts).values({
    accountId,
    tier: 'free',
    balance: '10',
    nonExpiringCredits: '10',
    ...(overrides ? { entitlementOverrides: overrides as never } : {}),
  });
  return accountId;
}

async function ledger(accountId: string) {
  return db
    .select({ amount: creditLedger.amount, key: creditLedger.idempotencyKey, metadata: creditLedger.metadata, description: creditLedger.description })
    .from(creditLedger)
    .where(and(eq(creditLedger.accountId, accountId), sql`${creditLedger.metadata}->>'ledger_type' = 'storage_debit'`))
    .orderBy(asc(creditLedger.createdAt));
}

async function chargeRows() {
  return db
    .select({
      resourceId: storageCharges.resourceId,
      accountId: storageCharges.accountId,
      projectId: storageCharges.projectId,
      sessionId: storageCharges.sessionId,
      reason: storageCharges.unattributedReason,
      waived: storageCharges.waived,
      chargedUsd: storageCharges.chargedUsd,
      chargeSeq: storageCharges.chargeSeq,
      pendingUsd: storageCharges.pendingUsd,
      platinumMicros: storageCharges.platinumMicros,
    })
    .from(storageCharges)
    .orderBy(asc(storageCharges.resourceId));
}

async function setCursor(day: string) {
  await deps.writeCursor(`${STORAGE_CURSOR_KEY}.home`, day);
}

let paying: string;
let project: { account_id: string; project_id: string };
let sessionId: string;
/** A box id per test: an established box identity cannot be deleted. */
let boxId: string;
/** Volume ids per test: the wallet key of a (volume, day, charge) is global, as in production. */
let driveVol: string;
let wsVol: string;
let waivedVol: string;

beforeEach(async () => {
  if (!confirmed) return;
  await db.execute(sql`DELETE FROM kortix.storage_charges`);
  // Each test owns these Platinum ids afresh: an earlier test's drive or box must not answer for them.
  const run = crypto.randomUUID().slice(0, 8);
  boxId = `sbx_${run}`;
  driveVol = `vol_drive_${run}`;
  wsVol = `vol_workspace_${run}`;
  waivedVol = `vol_waived_${run}`;
  await db.execute(sql`DELETE FROM kortix.platform_settings WHERE key LIKE ${`${STORAGE_CURSOR_KEY}%`}`);
  feed = {};
  names = {};
  lookups = [];
  failSettleOnce = null;
  paying = await account('storage-paying');
  project = await fixtures.seedProject('storage-project', { accountId: paying });
  sessionId = await fixtures.seedSession(project, USER);
  await db.insert(drives).values({
    accountId: paying,
    kind: 'project',
    name: 'Files',
    projectId: project.project_id,
    platinumVolumeId: driveVol,
    platinumVolumeName: `kd-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: paying,
    projectId: project.project_id,
    provider: 'platinum',
    externalId: boxId,
    status: 'active',
  });
  names[wsVol] = `kws-${sessionId}`;
  names.vol_other = 'home';
});

withDb('storage billing on PostgreSQL', () => {
  test('the first tick sets the cursor to today and charges nothing: never retroactive', async () => {
    feed[YESTERDAY] = [receipt('volume', driveVol, 1000)];
    await syncStorageCharges(deps);
    expect(await deps.readCursor(`${STORAGE_CURSOR_KEY}.home`)).toBe('2026-11-01');
    expect(await ledger(paying)).toEqual([]);
    expect(await chargeRows()).toEqual([]);
  });

  test('each volume is charged to its owner once; unattributed volumes are Kortix cost', async () => {
    await setCursor(YESTERDAY);
    feed[YESTERDAY] = [
      receipt('volume', driveVol, 1000), // a Files drive, by its recorded volume id
      receipt('volume', wsVol, 500), // kws-<session>, by Platinum's name
      receipt('scratch', boxId, 100), // a scratch disk, by its box
      receipt('volume', 'vol_other', 2000), // a volume no Kortix product made
      receipt('volume', 'vol_gone', 300), // Platinum no longer lists it
      receipt('volume_snapshot', 'snap_1', 10),
    ];
    const result = await syncStorageCharges(deps);
    expect(result).toMatchObject({ days: 1, charged: 3, unattributed: 3, waived: 0, failed: 0 });
    expect(result.chargedUsd).toBeCloseTo(0.082 + 0.041 + 0.0036, 10);

    const rows = await chargeRows();
    expect(rows.map((r) => [r.resourceId, r.accountId === paying, r.reason, Number(r.chargedUsd), r.chargeSeq])).toEqual([
      [boxId, true, null, 0.0036, 1],
      ['snap_1', false, 'unsupported_kind', 0, 0],
      [driveVol, true, null, 0.082, 1],
      ['vol_gone', false, 'volume_gone', 0, 0],
      ['vol_other', false, 'not_kortix', 0, 0],
      [wsVol, true, null, 0.041, 1],
    ]);
    // Kortix's own cost is what Platinum metered for the unattributed rows.
    expect(rows.filter((r) => !r.accountId).reduce((sum, r) => sum + r.platinumMicros, 0)).toBe(164_000 + 24_600 + 820);
    expect(rows.find((r) => r.resourceId === wsVol)).toMatchObject({ sessionId, projectId: project.project_id });

    const debits = await ledger(paying);
    expect(debits.map((d) => [d.key, Number(d.amount)])).toEqual(
      expect.arrayContaining([
        [`platinum-storage:home:volume:${driveVol}:${YESTERDAY}:1`, -0.082],
        [`platinum-storage:home:volume:${wsVol}:${YESTERDAY}:1`, -0.041],
        [`platinum-storage:home:scratch:${boxId}:${YESTERDAY}:1`, -0.0036],
      ]),
    );
    expect(debits).toHaveLength(3);
    expect(debits.find((d) => d.key?.includes(driveVol))?.description).toBe(`Files storage · ${YESTERDAY} · 1000.00 GiB-hours`);
    expect(debits.find((d) => d.key?.includes(driveVol))?.metadata).toMatchObject({
      ledger_type: 'storage_debit',
      platinum_resource_id: driveVol,
      usage_day: YESTERDAY,
      project_id: project.project_id,
    });
    // Within the revision window the day stays open.
    expect(await deps.readCursor(`${STORAGE_CURSOR_KEY}.home`)).toBe(YESTERDAY);
  });

  test('a replayed tick moves no money; late growth charges only the difference', async () => {
    await setCursor(YESTERDAY);
    feed[YESTERDAY] = [receipt('volume', driveVol, 1000), receipt('volume', wsVol, 500)];
    await syncStorageCharges(deps);
    lookups = [];
    await syncStorageCharges(deps);
    expect(await ledger(paying)).toHaveLength(2);
    // The owner is remembered: no second Platinum lookup.
    expect(lookups).toEqual([]);

    feed[YESTERDAY] = [receipt('volume', driveVol, 1250), receipt('volume', wsVol, 500)];
    await syncStorageCharges(deps);
    const debits = await ledger(paying);
    expect(debits.map((d) => [d.key, Number(d.amount)])).toContainEqual([`platinum-storage:home:volume:${driveVol}:${YESTERDAY}:2`, -0.0205]);
    expect(debits).toHaveLength(3);
    const drive = (await chargeRows()).find((r) => r.resourceId === driveVol);
    expect([Number(drive?.chargedUsd), drive?.chargeSeq]).toEqual([0.1025, 2]);
  });

  test('a wallet write whose row was not finalized replays under the same key, once', async () => {
    await setCursor(YESTERDAY);
    feed[YESTERDAY] = [receipt('volume', driveVol, 1000)];
    failSettleOnce = `platinum-storage:home:volume:${driveVol}:${YESTERDAY}:1`;
    const first = await syncStorageCharges(deps);
    expect(first.failed).toBe(1);
    expect((await chargeRows())[0]).toMatchObject({ chargeSeq: 0, pendingUsd: '0.0820000000' });

    // Platinum reads more by the next tick: the pending charge replays as it was, then the growth is charged.
    feed[YESTERDAY] = [receipt('volume', driveVol, 1100)];
    await syncStorageCharges(deps);
    const debits = await ledger(paying);
    expect(debits.map((d) => [d.key, Number(d.amount)])).toEqual([
      [`platinum-storage:home:volume:${driveVol}:${YESTERDAY}:1`, -0.082],
      [`platinum-storage:home:volume:${driveVol}:${YESTERDAY}:2`, -0.0082],
    ]);
    expect((await chargeRows())[0]).toMatchObject({ chargeSeq: 2, pendingUsd: null });
  });

  test('the storageBilling override waives the charge and records it', async () => {
    const waived = await account('storage-waived', { storageBilling: { value: false } });
    const waivedProject = await fixtures.seedProject('storage-waived', { accountId: waived });
    await db.insert(drives).values({
      accountId: waived,
      kind: 'project',
      name: 'Files',
      projectId: waivedProject.project_id,
      platinumVolumeId: waivedVol,
      platinumVolumeName: `kd-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    });
    invalidateAccountBilling(waived);
    await setCursor(YESTERDAY);
    feed[YESTERDAY] = [receipt('volume', waivedVol, 1000)];
    const result = await syncStorageCharges(deps);
    expect(result).toMatchObject({ charged: 0, waived: 1 });
    expect(await ledger(waived)).toEqual([]);
    expect((await chargeRows())[0]).toMatchObject({ waived: true, chargeSeq: 0, accountId: waived });
  });

  test("a deleted owner's volume becomes Kortix cost; nothing more is charged", async () => {
    await setCursor('2026-10-30');
    feed['2026-10-30'] = [receipt('volume', driveVol, 1000)];
    feed[YESTERDAY] = [receipt('volume', driveVol, 1000)];
    await syncStorageCharges(deps);
    expect(await ledger(paying)).toHaveLength(2);

    await db.delete(accounts).where(eq(accounts.accountId, paying));
    const rows = await chargeRows();
    expect(rows.every((r) => r.accountId === null && r.projectId === null)).toBe(true);
    // Both rows keep what was charged: the amounts stay auditable.
    expect(rows.map((r) => Number(r.chargedUsd))).toEqual([0.082, 0.082]);

    feed[YESTERDAY] = [receipt('volume', driveVol, 2000)];
    const result = await syncStorageCharges(deps);
    expect(result).toMatchObject({ charged: 0, unattributed: 2 });
  });
});
