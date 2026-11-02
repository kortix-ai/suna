// Box disk billing against a real PostgreSQL: the storage_charges rows and
// their watermarks, the compute windows that keep a running hour out, and the
// `storage_debit` rows the real wallet writes to credit_ledger. Only Platinum
// (the box list, at the module boundary) and the clock are faked.
import { beforeEach, describe, expect, test } from 'bun:test';
import { creditAccounts, creditLedger, sandboxComputeSessions, sessionSandboxes, storageCharges } from '@kortix/db';
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
  // The charge switch is off in deployments until the owner turns it on.
  KORTIX_BOX_DISK_CHARGE_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_box_disk',
  STRIPE_WEBHOOK_SECRET: 'whsec_box_disk',
  KORTIX_URL: 'http://127.0.0.1:1',
  PLATINUM_API_KEY: 'box-disk-test',
  PLATINUM_API_URL: 'http://127.0.0.1:1',
});

const { db } = await import('../../shared/db');
const { config } = await import('../../config');
const fixtures = await import('../../__tests__/helpers/integration-fixtures');
const { invalidateAccountBilling } = await import('./billing-cache');
const boxDisk = await import('./box-disk-charges');
const { syncBoxDiskCharges, boxDiskDeps, BOX_DISK_START_KEY, BOX_DISK_ARCHIVED_LISTED_KEY } = boxDisk;
type Box = import('./box-disk-charges').PlatinumBox;

const USER = '00000000-0000-4000-a000-000000005d01';
const MINE = 'marker-of-this-deployment';

let now: number;
/** Platinum's box list by state. */
let listed: { stopped: Box[]; archived: Box[] };
let listCalls: string[];

const deps: import('./box-disk-charges').BoxDiskDeps = {
  ...boxDiskDeps,
  feeds: () => [{ name: 'home' }],
  listBoxes: async (_feed, state) => {
    listCalls.push(state);
    return listed[state];
  },
  ownership: async () => (box) => box.metadata?.['kortix.managed'] === MINE,
  now: () => now,
};

const at = (iso: string) => Date.parse(iso);

function box(id: string, state: 'stopped' | 'archived', stoppedAt: string, extra: Partial<Box> = {}): Box {
  return { id, state, diskGb: 20, stoppedAt, billableSince: null, root_disk: null, metadata: { 'kortix.managed': MINE }, ...extra };
}

async function account(label: string, withCredits = true): Promise<string> {
  const accountId = await fixtures.seedAccount(label);
  if (withCredits) {
    await db.insert(creditAccounts).values({ accountId, tier: 'free', balance: '10', nonExpiringCredits: '10' });
  }
  invalidateAccountBilling(accountId);
  return accountId;
}

/** A session whose box is `externalId`; returns the Kortix sandbox id its compute windows carry. */
async function sessionBox(accountId: string, externalId: string): Promise<{ sandboxId: string; projectId: string; sessionId: string }> {
  const project = await fixtures.seedProject(`box-disk-${externalId}`, { accountId });
  const sessionId = await fixtures.seedSession(project, USER);
  const sandboxId = crypto.randomUUID();
  await db.insert(sessionSandboxes).values({
    sandboxId,
    sessionId,
    accountId,
    projectId: project.project_id,
    provider: 'platinum',
    externalId,
    status: 'stopped',
  });
  return { sandboxId, projectId: project.project_id, sessionId };
}

async function computeWindow(accountId: string, sandboxId: string, startedAt: string, endedAt: string | null) {
  await db.insert(sandboxComputeSessions).values({
    accountId,
    sandboxId,
    provider: 'platinum',
    cpuCores: 2,
    memoryGb: 4,
    diskGb: 20,
    state: endedAt ? 'stopped' : 'active',
    startedAt,
    lastBilledAt: endedAt ?? startedAt,
    endedAt,
  });
}

async function ledger(accountId: string) {
  return db
    .select({ amount: creditLedger.amount, key: creditLedger.idempotencyKey, description: creditLedger.description, metadata: creditLedger.metadata })
    .from(creditLedger)
    .where(and(eq(creditLedger.accountId, accountId), sql`${creditLedger.metadata}->>'ledger_type' = 'storage_debit'`))
    .orderBy(asc(creditLedger.createdAt));
}

async function rows(resourceId: string) {
  return db
    .select({
      kind: storageCharges.resourceKind,
      day: storageCharges.usageDay,
      gbHours: storageCharges.gibHours,
      accountId: storageCharges.accountId,
      projectId: storageCharges.projectId,
      sessionId: storageCharges.sessionId,
      reason: storageCharges.unattributedReason,
      waived: storageCharges.waived,
      chargedUsd: storageCharges.chargedUsd,
      chargeSeq: storageCharges.chargeSeq,
      platinumMicros: storageCharges.platinumMicros,
    })
    .from(storageCharges)
    .where(eq(storageCharges.resourceId, resourceId))
    .orderBy(asc(storageCharges.usageDay), asc(storageCharges.resourceKind));
}

let ids: { stopped: string; running: string; orphan: string; foreign: string; rooted: string; bare: string };

beforeEach(async () => {
  if (!confirmed) return;
  await db.execute(sql`DELETE FROM kortix.storage_charges`);
  await db.execute(sql`DELETE FROM kortix.platform_settings WHERE key LIKE 'platinum.box_disk.%'`);
  const run = crypto.randomUUID().slice(0, 8);
  ids = {
    stopped: `sbx_stopped_${run}`,
    running: `sbx_running_${run}`,
    orphan: `sbx_orphan_${run}`,
    foreign: `sbx_foreign_${run}`,
    rooted: `sbx_rooted_${run}`,
    bare: `sbx_bare_${run}`,
  };
  listed = { stopped: [], archived: [] };
  listCalls = [];
  // The meter's first tick: it starts here, never before.
  now = at('2026-10-31T06:00:00.000Z');
  await syncBoxDiskCharges(deps);
});

withDb('box disk billing on PostgreSQL', () => {
  test('the first tick only starts the meter', async () => {
    expect(await deps.readSetting(`${BOX_DISK_START_KEY}.home`)).toEqual({ at: '2026-10-31T06:00:00.000Z' });
    expect(listCalls).toEqual([]);
  });

  test('a stopped box is billed from the end of its compute window, per ended day, once; then archived at half', async () => {
    const paying = await account('box-disk-paying');
    const s = await sessionBox(paying, ids.stopped);
    // Kortix's compute window billed through 10:00:30; Platinum stopped the box at 10:00:00.
    await computeWindow(paying, s.sandboxId, '2026-10-31T08:00:00.000Z', '2026-10-31T10:00:30.000Z');
    listed.stopped = [box(ids.stopped, 'stopped', '2026-10-31T10:00:00.000Z')];

    now = at('2026-10-31T12:00:00.000Z');
    const noon = await syncBoxDiskCharges(deps);
    expect(noon).toMatchObject({ boxes: 1, metered: 1, charged: 0 });
    // The day has not ended: metered, not charged.
    expect(await ledger(paying)).toEqual([]);

    now = at('2026-11-01T00:30:00.000Z');
    await syncBoxDiskCharges(deps);
    // 10:00:30 → 24:00 is 13.991667 h × 20 GB = 279.8333 GB-hours at 72 µ$.
    const first = await ledger(paying);
    expect(first.map((d) => [d.key, Number(d.amount)])).toEqual([[`platinum-storage:home:box_disk:${ids.stopped}:2026-10-31:1`, -0.02014800]]);
    expect(first[0]?.description).toBe('Stopped computer disk · 2026-10-31 · 279.83 GB-hours');
    expect(first[0]?.metadata).toMatchObject({ project_id: s.projectId, session_id: s.sessionId, platinum_resource_id: ids.stopped });

    // Archived at 00:10 on 2026-11-02, after two days stopped (billableSince is stamped then).
    listed.stopped = [];
    listed.archived = [box(ids.stopped, 'archived', '2026-10-31T10:00:00.000Z', { billableSince: '2026-11-02T00:10:00.000Z' })];
    now = at('2026-11-02T06:00:00.000Z');
    await syncBoxDiskCharges(deps);
    // A replayed tick at the same instant that lists the archived boxes again: the watermark meters nothing twice.
    await deps.writeSetting(`${BOX_DISK_ARCHIVED_LISTED_KEY}.home`, { at: '2026-11-01T00:00:00.000Z' });
    const second = await syncBoxDiskCharges(deps);
    expect(second).toMatchObject({ boxes: 1, metered: 0, charged: 0, gbHours: 0 });

    const debits = (await ledger(paying)).map((d) => [d.key, Number(d.amount)]);
    expect(debits).toEqual([
      [`platinum-storage:home:box_disk:${ids.stopped}:2026-10-31:1`, -0.020148],
      [`platinum-storage:home:box_disk:${ids.stopped}:2026-11-01:1`, -0.03456], // 24 h × 20 GB, one charge
    ]);
    // The billing views count it as Storage: the project's storage_cost and the account's storage_usd.
    const { listCostByProject } = await import('../../shared/cost-rollups');
    const { getUsageBreakdownThisPeriod } = await import('./usage-breakdown');
    const page = await listCostByProject({
      accountId: paying,
      window: { from: new Date('2026-10-31T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z') },
      sort: 'total_desc',
      limit: 10,
      offset: 0,
    });
    const projectRow = page.projects.find((r) => r.project_id === s.projectId);
    expect(projectRow).toMatchObject({ storage_cost: 0.054708 });
    expect(Number(projectRow?.storage_gib_hours.toFixed(4))).toBe(759.8333);
    expect((await getUsageBreakdownThisPeriod(paying, '2026-10-01T00:00:00Z')).storage_usd).toBeCloseTo(0.054708, 10);

    expect((await rows(ids.stopped)).map((r) => [r.kind, r.day, Number(Number(r.gbHours).toFixed(4)), Number(r.chargedUsd)])).toEqual([
      ['box_disk', '2026-10-31', 279.8333, 0.020148],
      ['box_disk', '2026-11-01', 480, 0.03456],
      ['box_disk', '2026-11-02', 3.3333, 0], // 00:00 → 00:10, charged after the day ends
      ['box_disk_archived', '2026-11-02', 116.6667, 0], // 00:10 → 06:00 at 36 µ$
    ]);
  });

  test('with the charge switch off a stopped box is metered and recorded waived; nothing is debited', async () => {
    (config as { KORTIX_BOX_DISK_CHARGE_ENABLED: boolean }).KORTIX_BOX_DISK_CHARGE_ENABLED = false;
    try {
      const paying = await account('box-disk-switch-off');
      const s = await sessionBox(paying, ids.stopped);
      await computeWindow(paying, s.sandboxId, '2026-10-31T08:00:00.000Z', '2026-10-31T10:00:30.000Z');
      listed.stopped = [box(ids.stopped, 'stopped', '2026-10-31T10:00:00.000Z')];
      now = at('2026-11-01T00:30:00.000Z');
      const result = await syncBoxDiskCharges(deps);
      expect(result).toMatchObject({ charged: 0, waived: 1 });
      expect(await ledger(paying)).toEqual([]);
    } finally {
      (config as { KORTIX_BOX_DISK_CHARGE_ENABLED: boolean }).KORTIX_BOX_DISK_CHARGE_ENABLED = true;
    }
  });

  test('a box Kortix still bills as running is skipped; it is billed from the moment its window closes', async () => {
    const paying = await account('box-disk-running');
    const s = await sessionBox(paying, ids.running);
    await computeWindow(paying, s.sandboxId, '2026-10-31T07:00:00.000Z', null);
    // Platinum already says stopped: Kortix's open window still bills compute (and disk) for it.
    listed.stopped = [box(ids.running, 'stopped', '2026-10-31T09:00:00.000Z')];
    now = at('2026-10-31T12:00:00.000Z');
    expect(await syncBoxDiskCharges(deps)).toMatchObject({ boxes: 1, running: 1, metered: 0 });
    expect(await rows(ids.running)).toEqual([]);

    await db
      .update(sandboxComputeSessions)
      .set({ endedAt: '2026-10-31T13:00:00.000Z', lastBilledAt: '2026-10-31T13:00:00.000Z', state: 'stopped' })
      .where(eq(sandboxComputeSessions.sandboxId, s.sandboxId));
    now = at('2026-10-31T14:00:00.000Z');
    await syncBoxDiskCharges(deps);
    expect((await rows(ids.running)).map((r) => [r.day, Number(r.gbHours)])).toEqual([['2026-10-31', 20]]);
  });

  test("Kortix's own cost: an unowned box of this deployment is recorded, never charged; other boxes are left alone", async () => {
    const bare = await account('box-disk-no-credit-row', false);
    await sessionBox(bare, ids.bare);
    listed.stopped = [
      box(ids.orphan, 'stopped', '2026-10-31T00:00:00.000Z'),
      box(ids.foreign, 'stopped', '2026-10-31T00:00:00.000Z', { metadata: { 'kortix.managed': 'another-deployment' } }),
      box(ids.rooted, 'stopped', '2026-10-31T00:00:00.000Z', { root_disk: { volume_id: 'vol_root' } }),
      box(ids.bare, 'stopped', '2026-10-31T00:00:00.000Z'),
    ];
    now = at('2026-11-01T01:00:00.000Z');
    const result = await syncBoxDiskCharges(deps);
    expect(result).toMatchObject({ boxes: 3, foreign: 1, unattributed: 1, waived: 1, charged: 0 });

    const orphan = await rows(ids.orphan);
    // 06:00 (the meter's start) → 24:00 = 18 h × 20 GB at 72 µ$ = 25,920 µ$ Kortix pays.
    expect(orphan[0]).toMatchObject({ day: '2026-10-31', accountId: null, reason: 'owner_gone', platinumMicros: 25_920 });
    expect(await rows(ids.foreign)).toEqual([]);
    expect(await rows(ids.rooted)).toEqual([]);
    // No credit account: compute's rule, nothing to debit; the day is closed as waived.
    expect((await rows(ids.bare)).find((r) => r.day === '2026-10-31')).toMatchObject({ accountId: bare, waived: true, chargeSeq: 0 });
    expect(await ledger(bare)).toEqual([]);
  });

  test('archived boxes are listed every 6 hours and on the first tick of a day', async () => {
    now = at('2026-10-31T07:00:00.000Z');
    await syncBoxDiskCharges(deps);
    now = at('2026-10-31T08:00:00.000Z');
    await syncBoxDiskCharges(deps);
    now = at('2026-10-31T13:00:00.000Z');
    await syncBoxDiskCharges(deps);
    now = at('2026-11-01T00:05:00.000Z');
    await syncBoxDiskCharges(deps);
    expect(listCalls).toEqual(['stopped', 'archived', 'stopped', 'stopped', 'archived', 'stopped', 'archived']);
    expect(await deps.readSetting(`${BOX_DISK_ARCHIVED_LISTED_KEY}.home`)).toEqual({ at: '2026-11-01T00:05:00.000Z' });
  });

  test('a day that ends archived charges its stopped hours as soon as the box is metered past midnight', async () => {
    const paying = await account('box-disk-archived-at-night');
    await sessionBox(paying, ids.stopped);
    listed.stopped = [box(ids.stopped, 'stopped', '2026-10-30T23:00:00.000Z')];
    now = at('2026-10-31T23:00:00.000Z');
    await syncBoxDiskCharges(deps);
    // Archived at 23:36 the same day: the stopped row ends at 23:36, the archived row runs on.
    listed.stopped = [];
    listed.archived = [box(ids.stopped, 'archived', '2026-10-30T23:00:00.000Z', { billableSince: '2026-10-31T23:36:00.000Z' })];
    now = at('2026-11-01T00:30:00.000Z');
    await syncBoxDiskCharges(deps);
    expect((await ledger(paying)).map((d) => [d.key, Number(d.amount)])).toEqual([
      [`platinum-storage:home:box_disk:${ids.stopped}:2026-10-31:1`, -0.025344], // 06:00 → 23:36 = 17.6 h × 20 GB × 72 µ$
      [`platinum-storage:home:box_disk_archived:${ids.stopped}:2026-10-31:1`, -0.000288], // 23:36 → 24:00 = 0.4 h × 20 GB × 36 µ$
    ]);
  });
});
