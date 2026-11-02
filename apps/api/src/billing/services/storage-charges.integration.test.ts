// Storage billing against a real PostgreSQL: the storage_charges rows, the
// cursors, and the `storage_debit` rows the real wallet writes to
// credit_ledger. Only Platinum (the network boundary: the volume-usage
// receipts, the volume.storage events feed and the volume lookup) is faked.
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
const { syncStorageCharges, storageChargeDeps, STORAGE_CURSOR_KEY, STORAGE_EVENTS_KEY } = storage;
type Page = import('./storage-charges').PlatinumVolumeUsagePage;
type StorageEvent = import('./storage-charges').PlatinumStorageEvent;

const USER = '00000000-0000-4000-a000-000000005c01';
const NOW = Date.parse('2026-11-01T06:00:00.000Z');
const YESTERDAY = '2026-10-31';

/** Platinum's receipts per day, and its volume names by id. A missing name is a 404. */
let feed: Record<string, Page['resources']>;
let names: Record<string, string>;
let lookups: string[];
let failSettleOnce: string | null;
/** Platinum's volume.storage events, oldest first; null = a Platinum without the events feed (404). */
let events: StorageEvent[] | null;
/** The receipt days the tick read. */
let usageReads: string[];

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
  usage: async (_feed, day) => {
    usageReads.push(day);
    return page(day);
  },
  // Platinum's paging: the cursor is the last event's own cursor; next_cursor only when the page is full.
  storageEvents: async (_feed, cursor) => {
    if (!events) return null;
    const after = cursor ? events.findIndex((e) => e.cursor === cursor) + 1 : 0;
    const slice = events.slice(after, after + 2);
    return { events: slice, next_cursor: after + 2 < events.length ? (slice[slice.length - 1]?.cursor ?? null) : null };
  },
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

/** One `volume.storage` event, in Platinum's shape (billingEvents.ts), for `gibHours` of `day`. */
function event(id: string, kind: string, resourceId: string, name: string | null, day: string, gibHours: number, startHour = 0): StorageEvent {
  const started = `${day}T${String(startHour).padStart(2, '0')}:00:00.000Z`;
  return {
    id,
    cursor: `c_${id}`,
    sandbox_id: kind === 'scratch' ? resourceId : null,
    event_type: 'volume.storage',
    size_class: kind,
    quantity: gibHours,
    unit_price_micros: 82,
    amount_micros: Math.round(gibHours * 82),
    ts: `${day}T23:59:00.000Z`,
    resource: { kind, id: resourceId, name, region: 'eu-west', bytes: 1, started_at: started, ended_at: `${day}T23:59:59.000Z`, debited_micros: 0 },
  };
}

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
  // The events feed started with the receipts.
  await deps.writeEventsState(`${STORAGE_EVENTS_KEY}.home`, { cursor: null, since: day, fullFrom: null });
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
  await db.execute(sql`DELETE FROM kortix.platform_settings WHERE key LIKE ${`${STORAGE_EVENTS_KEY}%`}`);
  events = null;
  usageReads = [];
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

  test('an account with no credit account is not charged and does not hold the day open', async () => {
    // Compute's rule: no credit account, nothing to debit, nothing metered.
    const bare = await fixtures.seedAccount('storage-no-credit-row');
    const bareProject = await fixtures.seedProject('storage-no-credit-row', { accountId: bare });
    const bareVol = `vol_bare_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(drives).values({
      accountId: bare,
      kind: 'project',
      name: 'Files',
      projectId: bareProject.project_id,
      platinumVolumeId: bareVol,
      platinumVolumeName: `kd-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    });
    invalidateAccountBilling(bare);
    await setCursor(YESTERDAY);
    feed[YESTERDAY] = [receipt('volume', bareVol, 1000)];
    const result = await syncStorageCharges(deps);
    expect(result).toMatchObject({ charged: 0, waived: 1, failed: 0 });
    expect(await ledger(bare)).toEqual([]);
    expect((await chargeRows()).find((r) => r.accountId === bare)).toMatchObject({ waived: true, chargeSeq: 0 });
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

  test('the events feed charges each event once, by the name it carries; receipts are not read for its days', async () => {
    await setCursor('2026-10-30');
    const driveName = (await db.select({ name: drives.platinumVolumeName }).from(drives).where(eq(drives.platinumVolumeId, driveVol)))[0]?.name ?? null;
    // Platinum's receipts disagree on purpose: a tick that read them would charge 9,999 GiB-hours.
    feed[YESTERDAY] = [receipt('volume', driveVol, 9999)];
    events = [
      event('vbe_0', 'volume', driveVol, driveName, '2026-10-29', 50), // before the feed's first tick: never charged
      event('vbe_1', 'volume', driveVol, driveName, YESTERDAY, 1000),
      event('vbe_2', 'volume', wsVol, `kws-${sessionId}`, YESTERDAY, 500),
      event('vbe_3', 'worker_storage', 'org_1/kortix-pi-cell', 'kortix-pi-cell', YESTERDAY, 10),
      event('vbe_4', 'volume', 'vol_other', 'home', YESTERDAY, 100),
    ];
    const result = await syncStorageCharges(deps);
    expect(result).toMatchObject({ events: 4, charged: 2, unattributed: 2, failed: 0 });
    expect(lookups).toEqual([]);
    // The first event is dated 2026-10-29, so the feed covers 2026-10-30 on in full: no receipt is read.
    expect(usageReads).toEqual([]);
    expect((await ledger(paying)).map((d) => [d.key, Number(d.amount)])).toEqual([
      [`platinum-storage:home:volume:${driveVol}:${YESTERDAY}:1`, -0.082],
      [`platinum-storage:home:volume:${wsVol}:${YESTERDAY}:1`, -0.041],
    ]);
    const rows = await chargeRows();
    expect(rows.find((r) => r.resourceId === 'org_1/kortix-pi-cell')).toMatchObject({ accountId: null, reason: 'unsupported_kind' });
    expect(rows.find((r) => r.resourceId === 'vol_other')).toMatchObject({ accountId: null, reason: 'not_kortix' });
    expect(await deps.readEventsState(`${STORAGE_EVENTS_KEY}.home`)).toEqual({ cursor: 'c_vbe_4', since: '2026-10-30', fullFrom: '2026-10-30' });

    // A second tick, and a replay of the whole feed (a lost cursor): no event is applied twice.
    await syncStorageCharges(deps);
    await deps.writeEventsState(`${STORAGE_EVENTS_KEY}.home`, { cursor: null, since: '2026-10-30', fullFrom: '2026-10-30' });
    const replay = await syncStorageCharges(deps);
    expect(replay).toMatchObject({ charged: 0 });
    expect(await ledger(paying)).toHaveLength(2);

    // Growth Platinum bills back to an ended day arrives as a new event: only it is charged.
    events.push(event('vbe_5', 'volume', driveVol, driveName, YESTERDAY, 250, 12));
    await syncStorageCharges(deps);
    expect((await ledger(paying)).map((d) => [d.key, Number(d.amount)])).toContainEqual([
      `platinum-storage:home:volume:${driveVol}:${YESTERDAY}:2`,
      -0.0205,
    ]);
    expect(await ledger(paying)).toHaveLength(3);
  });

  test('a Platinum whose events feed is empty keeps the receipts', async () => {
    await setCursor(YESTERDAY);
    events = [];
    feed[YESTERDAY] = [receipt('volume', driveVol, 1000)];
    const result = await syncStorageCharges(deps);
    expect(result).toMatchObject({ days: 1, events: 0, charged: 1 });
    expect(usageReads).toEqual([YESTERDAY]);
  });

  test('switch-over: a day charged from receipts is not charged again from its events, and nothing falls between', async () => {
    await setCursor('2026-10-30');
    feed['2026-10-30'] = [receipt('volume', driveVol, 1000)];
    feed[YESTERDAY] = [receipt('volume', driveVol, 1000)];
    await syncStorageCharges(deps);
    expect(await ledger(paying)).toHaveLength(2);

    // Platinum starts its events mid-day on 2026-10-30: that day is partial, the next is whole.
    events = [
      event('vbe_a', 'volume', driveVol, null, '2026-10-30', 250, 18),
      event('vbe_b', 'volume', driveVol, null, YESTERDAY, 1000),
    ];
    usageReads = [];
    const switched = await syncStorageCharges(deps);
    expect(switched).toMatchObject({ events: 2, charged: 0 });
    expect(await ledger(paying)).toHaveLength(2);
    expect((await deps.readEventsState(`${STORAGE_EVENTS_KEY}.home`))?.fullFrom).toBe(YESTERDAY);
    // The partial day still reads its receipt (late growth lands there); the whole day reads events only.
    expect(usageReads).toEqual(['2026-10-30']);

    // Late growth on each side of the switch is charged once, by the source that covers the day.
    feed['2026-10-30'] = [receipt('volume', driveVol, 1100)];
    feed[YESTERDAY] = [receipt('volume', driveVol, 5000)]; // not read any more
    events.push(event('vbe_c', 'volume', driveVol, null, YESTERDAY, 200, 6));
    await syncStorageCharges(deps);
    const debits = (await ledger(paying)).map((d) => [d.key, Number(d.amount)]);
    expect(debits).toHaveLength(4);
    expect(debits).toEqual(
      expect.arrayContaining([
        [`platinum-storage:home:volume:${driveVol}:2026-10-30:1`, -0.082],
        [`platinum-storage:home:volume:${driveVol}:${YESTERDAY}:1`, -0.082],
        [`platinum-storage:home:volume:${driveVol}:2026-10-30:2`, -0.0082],
        [`platinum-storage:home:volume:${driveVol}:${YESTERDAY}:2`, -0.0164],
      ]),
    );
  });
});
