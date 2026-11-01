/**
 * Volume storage billing: Platinum meters every volume Kortix creates (a
 * project's Files drive `kd-…`, a session's /workspace volume `kws-<session>`,
 * a box's scratch disk) on its compressed unique bytes, settled into one
 * receipt per (volume, UTC day). `GET /v1/billing/volume-usage` lists those
 * receipts. This tick turns each into a charge in credits on the account that
 * owns the volume, at the Kortix storage rate
 * (STORAGE_RATES_USD_PER_GIB_HOUR, platform/providers/compute-rates.ts).
 *
 * Granularity: one row in kortix.storage_charges per (control plane, meter,
 * volume, UTC day). A day is charged once it has ended. Platinum can still add
 * GiB-hours to an ended day (its daily sweep bills growth back to the commits
 * that made it), so each day stays open for STORAGE_REVISION_DAYS and every
 * tick charges the difference between what Platinum metered and what Kortix
 * already charged.
 *
 * Exactly once: each charge has its own sequence number. The row records the
 * charge (pending_*) before the wallet call, the wallet key is
 * `platinum-storage:<feed>:<kind>:<resource>:<day>:<seq>`, and the row is
 * finalized after. A crash between the two replays the same pending amount
 * under the same key, which moves no money twice.
 *
 * Attribution: drive → account and project; `kws-<session_id>` → session →
 * account and project; a scratch disk → the session box. A volume Kortix
 * cannot attribute (another deployment's in the same Platinum org, a deleted
 * owner, a volume Platinum no longer lists) is recorded with no account and
 * an `unattributed_reason`: Kortix's own cost, never charged to anyone.
 *
 * Cursor: `platinum.volume_storage.cursor.<feed>` in kortix.platform_settings
 * holds the oldest UTC day still open. The first tick sets it to today: usage
 * before this feature shipped is never billed.
 */
import { drives, platformSettings, projectSessions, sessionSandboxes, storageCharges } from '@kortix/db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { STORAGE_RATES_USD_PER_GIB_HOUR, type StorageResourceKind } from '../../platform/providers/compute-rates';
import { db } from '../../shared/db';
import { platinumJson, platinumRegionControlPlane } from '../../shared/platinum';
import { platinumUsRegion } from '../../shared/platinum-region';
import type { SettleInput } from '../wallet';
import { resolveAccountBilling } from './billing-cache';
import { settleAndCheckAutoTopup } from './wallet-debits';

export const STORAGE_CURSOR_KEY = 'platinum.volume_storage.cursor';
/** An ended day is read again on this many later days, for late growth. */
export const STORAGE_REVISION_DAYS = 3;
/** Days a tick reads at most, oldest first: a worker down for weeks catches up over several ticks. */
const MAX_DAYS_PER_TICK = 7;
/** A day that still fails this long after it ended leaves the window (logged): it cannot pin the cursor. */
const MAX_OPEN_DAYS = 14;
/** Platinum's largest page; the endpoint has no cursor (see the truncation log below). */
const USAGE_PAGE_LIMIT = 1000;
/** Volume names looked up per tick; the rest resolve on the next tick. */
const MAX_NAME_LOOKUPS_PER_TICK = 300;
/** A difference below this stays uncharged until it grows past it. */
export const MIN_STORAGE_CHARGE_USD = 0.000001;
const DAY_MS = 86_400_000;

export type UnattributedReason = 'not_kortix' | 'volume_gone' | 'owner_gone' | 'unsupported_kind';

export interface PlatinumVolumeUsageResource {
  resource_kind: string;
  resource_id: string;
  gib_hours: number;
  metered_micros: number;
}

export interface PlatinumVolumeUsagePage {
  total_gib_hours: number;
  total_metered_micros: number;
  resources: PlatinumVolumeUsageResource[];
}

/** One control plane. `origin` undefined is PLATINUM_API_URL. */
export interface StorageFeed {
  name: string;
  origin?: string;
}

export interface StorageOwner {
  accountId: string | null;
  projectId: string | null;
  sessionId: string | null;
  driveId: string | null;
  volumeName: string | null;
  unattributedReason: UnattributedReason | null;
}

/** The charge state of one (feed, kind, resource, day) row. */
export interface StorageChargeState {
  chargedGibHours: number;
  chargeSeq: number;
  pendingGibHours: number | null;
  pendingUsd: number | null;
}

export type StorageChargePlan =
  | { action: 'none' }
  | { action: 'replay'; seq: number; gibHours: number; amountUsd: number }
  | { action: 'charge'; seq: number; gibHours: number; amountUsd: number };

/** USD for `gibHours` of one meter, rounded to the ledger's 10 decimals. */
export function storageChargeUsd(kind: StorageResourceKind, gibHours: number): number {
  return Math.round(gibHours * STORAGE_RATES_USD_PER_GIB_HOUR[kind] * 1e10) / 1e10;
}

/**
 * The next wallet write for a row: a pending charge first (same key, same
 * amount), else the GiB-hours Platinum metered past what was charged. Never a
 * refund: a smaller reading than what was charged charges nothing.
 */
export function planStorageCharge(
  kind: StorageResourceKind,
  state: StorageChargeState,
  meteredGibHours: number,
): StorageChargePlan {
  if (state.pendingGibHours !== null && state.pendingUsd !== null) {
    return { action: 'replay', seq: state.chargeSeq + 1, gibHours: state.pendingGibHours, amountUsd: state.pendingUsd };
  }
  if (!Number.isFinite(meteredGibHours)) return { action: 'none' };
  const amountUsd = storageChargeUsd(kind, meteredGibHours - state.chargedGibHours);
  if (amountUsd < MIN_STORAGE_CHARGE_USD) return { action: 'none' };
  return { action: 'charge', seq: state.chargeSeq + 1, gibHours: meteredGibHours, amountUsd };
}

export function storageChargeKey(feed: string, kind: string, resourceId: string, day: string, seq: number): string {
  return `platinum-storage:${feed}:${kind}:${resourceId}:${day}:${seq}`;
}

const DRIVE_VOLUME = /^kd-[0-9a-f]{20}$/;
const WORKSPACE_VOLUME = /^kws-(.+)$/;

/** What a volume name says about its owner: a Files drive, a session's /workspace, or neither. */
export function classifyVolumeName(name: string): { kind: 'drive' } | { kind: 'workspace'; sessionId: string } | { kind: 'other' } {
  if (DRIVE_VOLUME.test(name)) return { kind: 'drive' };
  const workspace = WORKSPACE_VOLUME.exec(name);
  if (workspace?.[1]) return { kind: 'workspace', sessionId: workspace[1] };
  return { kind: 'other' };
}

export function isStorageResourceKind(kind: string): kind is StorageResourceKind {
  return kind === 'volume' || kind === 'volume_snapshot' || kind === 'scratch';
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function addDays(day: string, days: number): string {
  return utcDay(dayStartMs(day) + days * DAY_MS);
}

/** The ended days a tick reads: from the cursor through yesterday, oldest first, at most MAX_DAYS_PER_TICK. */
export function storageDaysToRead(cursor: string, today: string): string[] {
  const floor = addDays(today, -MAX_OPEN_DAYS);
  const days: string[] = [];
  for (let day = cursor < floor ? floor : cursor; day < today && days.length < MAX_DAYS_PER_TICK; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The cursor after a tick: the oldest day that is still open. A day stays open
 * while it is within STORAGE_REVISION_DAYS of today, failed this tick, or was
 * not read this tick.
 */
export function nextStorageCursor(cursor: string, today: string, read: string[], failed: ReadonlySet<string>): string {
  const revisionFloor = addDays(today, -STORAGE_REVISION_DAYS);
  const oldestFailed = read.find((day) => failed.has(day));
  const unread = read.length ? addDays(read[read.length - 1] as string, 1) : cursor;
  const candidates = [revisionFloor, unread, ...(oldestFailed ? [oldestFailed] : [])];
  const next = candidates.reduce((min, day) => (day < min ? day : min));
  // Never back past where it was, and never older than the open-day floor.
  const floor = addDays(today, -MAX_OPEN_DAYS);
  if (next < cursor) return cursor < floor ? floor : cursor;
  return next < floor ? floor : next;
}

interface StoredRow extends StorageChargeState, StorageOwner {
  id: string;
  resourceKind: StorageResourceKind;
  resourceId: string;
  usageDay: string;
  waived: boolean;
}

export interface StorageChargeDeps {
  feeds(): StorageFeed[];
  /** One UTC day of Platinum's volume receipts, or null when this Platinum has no volume meter (404). */
  usage(feed: StorageFeed, day: string): Promise<PlatinumVolumeUsagePage | null>;
  /** A volume's name by id, or null when Platinum no longer lists it (404). */
  volumeName(feed: StorageFeed, volumeId: string): Promise<string | null>;
  readCursor(key: string): Promise<string | null>;
  writeCursor(key: string, day: string): Promise<void>;
  /** Whether the account's storageBilling entitlement is on. */
  storageBilled(accountId: string): Promise<boolean>;
  settle(input: SettleInput): Promise<unknown>;
  now(): number;
}

export const storageChargeDeps: StorageChargeDeps = {
  feeds() {
    const region = platinumUsRegion();
    const origin = region ? platinumRegionControlPlane(region) : null;
    return [{ name: 'home' }, ...(region && origin ? [{ name: region, origin }] : [])];
  },
  async usage(feed, day) {
    const start = dayStartMs(day);
    const query = new URLSearchParams({ since_ms: String(start), until_ms: String(start), limit: String(USAGE_PAGE_LIMIT) });
    try {
      return await platinumJson<PlatinumVolumeUsagePage>(`/v1/billing/volume-usage?${query}`, {}, feed.origin);
    } catch (error) {
      if (error instanceof Error && (error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  },
  async volumeName(feed, volumeId) {
    try {
      const volume = await platinumJson<{ name?: unknown }>(`/v1/volumes/${encodeURIComponent(volumeId)}`, {}, feed.origin);
      return typeof volume.name === 'string' && volume.name ? volume.name : null;
    } catch (error) {
      if (error instanceof Error && (error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  },
  async readCursor(key) {
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, key));
    const day = (row?.value as { day?: unknown } | undefined)?.day;
    return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  },
  async writeCursor(key, day) {
    await db
      .insert(platformSettings)
      .values({ key, value: { day } })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: { day }, updatedAt: new Date() } });
  },
  async storageBilled(accountId) {
    return (await resolveAccountBilling(accountId)).entitlements.storageBilling !== false;
  },
  settle: settleAndCheckAutoTopup,
  now: () => Date.now(),
};

export interface StorageChargeResult {
  days: number;
  charged: number;
  chargedUsd: number;
  unattributed: number;
  waived: number;
  failed: number;
}

// replica-local: feeds this process already logged as missing (404); a peer logs its own once.
const missingFeedLogged = new Set<string>();

/** Charge every volume receipt Platinum settled since the last tick. */
export async function syncStorageCharges(deps: StorageChargeDeps = storageChargeDeps): Promise<StorageChargeResult> {
  const total: StorageChargeResult = { days: 0, charged: 0, chargedUsd: 0, unattributed: 0, waived: 0, failed: 0 };
  const lookups = { left: MAX_NAME_LOOKUPS_PER_TICK };
  for (const feed of deps.feeds()) {
    try {
      await syncFeed(feed, deps, total, lookups);
    } catch (error) {
      logger.error('[storage-billing] charge sync failed; the next tick retries', {
        feed: feed.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return total;
}

async function syncFeed(
  feed: StorageFeed,
  deps: StorageChargeDeps,
  total: StorageChargeResult,
  lookups: { left: number },
): Promise<void> {
  const key = `${STORAGE_CURSOR_KEY}.${feed.name}`;
  const today = utcDay(deps.now());
  const cursor = await deps.readCursor(key);
  if (!cursor) {
    // Never retroactive: the first day charged is the one this tick runs on.
    await deps.writeCursor(key, today);
    return;
  }
  const days = storageDaysToRead(cursor, today);
  const failed = new Set<string>();
  const read: string[] = [];
  for (const day of days) {
    const page = await deps.usage(feed, day);
    if (!page) {
      if (!missingFeedLogged.has(feed.name)) {
        missingFeedLogged.add(feed.name);
        logger.warn('[storage-billing] this Platinum has no volume meter (404); no storage is charged', { feed: feed.name });
      }
      return;
    }
    read.push(day);
    total.days += 1;
    const ok = await chargeDay(feed, day, page, deps, total, lookups);
    if (!ok) failed.add(day);
  }
  const next = nextStorageCursor(cursor, today, read, failed);
  if (next !== cursor) await deps.writeCursor(key, next);
}

/** Charge one day of one feed. Returns false when any resource must be retried. */
async function chargeDay(
  feed: StorageFeed,
  day: string,
  page: PlatinumVolumeUsagePage,
  deps: StorageChargeDeps,
  total: StorageChargeResult,
  lookups: { left: number },
): Promise<boolean> {
  const resources = (Array.isArray(page.resources) ? page.resources : []).filter((r) => {
    if (typeof r?.resource_id === 'string' && r.resource_id && isStorageResourceKind(r.resource_kind)) return true;
    logger.error('[storage-billing] malformed volume receipt skipped', { feed: feed.name, day, resource: r });
    return false;
  });
  if (resources.length >= USAGE_PAGE_LIMIT) {
    // GET /v1/billing/volume-usage has no cursor: past 1,000 resources a day the
    // smallest receipts are not listed. Recorded as Kortix's own cost here.
    const listed = resources.reduce((sum, r) => sum + (Number(r.gib_hours) || 0), 0);
    logger.error('[storage-billing] Platinum listed only the largest volumes of the day; the rest are not charged', {
      feed: feed.name,
      day,
      listed: resources.length,
      unlistedGibHours: Math.max(0, (Number(page.total_gib_hours) || 0) - listed),
    });
  }
  const existing = await loadDayRows(feed.name, day, resources);
  const owners = await resolveOwners(feed, deps, resources.filter((r) => !existing.has(rowKey(r))), lookups);
  let ok = true;
  for (const resource of resources) {
    const kind = resource.resource_kind as StorageResourceKind;
    const gibHours = Math.max(Number(resource.gib_hours) || 0, 0);
    const micros = Math.max(Math.round(Number(resource.metered_micros) || 0), 0);
    let row = existing.get(rowKey(resource)) ?? null;
    try {
      if (!row) {
        const owner = owners.get(rowKey(resource));
        if (!owner) {
          ok = false; // Name lookups ran out this tick: the next tick resolves it.
          continue;
        }
        row = await insertRow(feed.name, day, kind, resource.resource_id, owner, gibHours, micros);
      } else {
        await recordReading(row.id, gibHours, micros);
      }
      const outcome = await chargeRow(feed, row, gibHours, deps);
      if (outcome === 'unattributed') total.unattributed += 1;
      else if (outcome === 'waived') total.waived += 1;
      else if (typeof outcome === 'number') {
        total.charged += 1;
        total.chargedUsd += outcome;
      }
    } catch (error) {
      ok = false;
      total.failed += 1;
      logger.error('[storage-billing] charge failed; the next tick retries it with the same key', {
        feed: feed.name,
        day,
        resourceKind: kind,
        resourceId: resource.resource_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok;
}

/** Charge one row up to Platinum's reading. Returns the USD charged, or why nothing was. */
async function chargeRow(
  feed: StorageFeed,
  row: StoredRow,
  meteredGibHours: number,
  deps: StorageChargeDeps,
): Promise<number | 'unattributed' | 'waived' | 'none'> {
  if (!row.accountId) return 'unattributed';
  let state: StorageChargeState = row;
  let charged = 0;
  // At most a replay and one new charge.
  for (let step = 0; step < 2; step++) {
    const plan = planStorageCharge(row.resourceKind, state, meteredGibHours);
    if (plan.action === 'none') break;
    if (plan.action === 'charge') {
      if (!(await deps.storageBilled(row.accountId))) {
        await markWaived(row.id, true);
        return 'waived';
      }
      await markPending(row.id, state.chargeSeq, plan.gibHours, plan.amountUsd);
    }
    const deltaGibHours = plan.gibHours - state.chargedGibHours;
    await deps.settle({
      accountId: row.accountId,
      amount: plan.amountUsd,
      description: `${storageLabel(row)} · ${row.usageDay} · ${deltaGibHours.toFixed(2)} GiB-hours`,
      kind: 'storage_debit',
      key: { request: storageChargeKey(feed.name, row.resourceKind, row.resourceId, row.usageDay, plan.seq) },
      audit: {
        storage_feed: feed.name,
        storage_resource_kind: row.resourceKind,
        platinum_resource_id: row.resourceId,
        usage_day: row.usageDay,
        gib_hours: deltaGibHours,
        charge_seq: plan.seq,
        project_id: row.projectId,
        session_id: row.sessionId,
        drive_id: row.driveId,
      },
    });
    await finalizeCharge(row.id, plan.seq, plan.gibHours, plan.amountUsd);
    charged += plan.amountUsd;
    state = { chargedGibHours: plan.gibHours, chargeSeq: plan.seq, pendingGibHours: null, pendingUsd: null };
  }
  if (row.waived && charged > 0) await markWaived(row.id, false);
  return charged > 0 ? charged : 'none';
}

function storageLabel(row: Pick<StoredRow, 'resourceKind' | 'driveId' | 'sessionId'>): string {
  if (row.resourceKind === 'scratch') return 'Scratch disk';
  if (row.driveId) return 'Files storage';
  if (row.sessionId) return 'Workspace storage';
  return 'Storage';
}

function rowKey(resource: { resource_kind: string; resource_id: string }): string {
  return `${resource.resource_kind}:${resource.resource_id}`;
}

const ROW_COLUMNS = {
  id: storageCharges.id,
  resourceKind: storageCharges.resourceKind,
  resourceId: storageCharges.resourceId,
  usageDay: storageCharges.usageDay,
  accountId: storageCharges.accountId,
  projectId: storageCharges.projectId,
  sessionId: storageCharges.sessionId,
  driveId: storageCharges.driveId,
  volumeName: storageCharges.volumeName,
  unattributedReason: storageCharges.unattributedReason,
  waived: storageCharges.waived,
  chargedGibHours: storageCharges.chargedGibHours,
  chargeSeq: storageCharges.chargeSeq,
  pendingGibHours: storageCharges.pendingGibHours,
  pendingUsd: storageCharges.pendingUsd,
};

type RawRow = { [K in keyof typeof ROW_COLUMNS]: unknown };

function toStoredRow(raw: RawRow): StoredRow {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    id: raw.id as string,
    resourceKind: raw.resourceKind as StorageResourceKind,
    resourceId: raw.resourceId as string,
    usageDay: raw.usageDay as string,
    accountId: (raw.accountId as string | null) ?? null,
    projectId: (raw.projectId as string | null) ?? null,
    sessionId: (raw.sessionId as string | null) ?? null,
    driveId: (raw.driveId as string | null) ?? null,
    volumeName: (raw.volumeName as string | null) ?? null,
    unattributedReason: (raw.unattributedReason as UnattributedReason | null) ?? null,
    waived: raw.waived === true,
    chargedGibHours: num(raw.chargedGibHours) ?? 0,
    chargeSeq: Number(raw.chargeSeq) || 0,
    pendingGibHours: num(raw.pendingGibHours),
    pendingUsd: num(raw.pendingUsd),
  };
}

async function loadDayRows(feed: string, day: string, resources: PlatinumVolumeUsageResource[]): Promise<Map<string, StoredRow>> {
  const rows = new Map<string, StoredRow>();
  if (!resources.length) return rows;
  const found = await db
    .select(ROW_COLUMNS)
    .from(storageCharges)
    .where(
      and(
        eq(storageCharges.feed, feed),
        eq(storageCharges.usageDay, day),
        inArray(storageCharges.resourceId, resources.map((r) => r.resource_id)),
      ),
    );
  for (const raw of found) {
    const row = toStoredRow(raw);
    rows.set(rowKey({ resource_kind: row.resourceKind, resource_id: row.resourceId }), row);
  }
  return rows;
}

async function insertRow(
  feed: string,
  day: string,
  kind: StorageResourceKind,
  resourceId: string,
  owner: StorageOwner,
  gibHours: number,
  micros: number,
): Promise<StoredRow> {
  const [raw] = await db
    .insert(storageCharges)
    .values({
      feed,
      resourceKind: kind,
      resourceId,
      usageDay: day,
      accountId: owner.accountId,
      projectId: owner.projectId,
      sessionId: owner.sessionId,
      driveId: owner.driveId,
      volumeName: owner.volumeName,
      unattributedReason: owner.accountId ? null : (owner.unattributedReason ?? 'owner_gone'),
      gibHours: String(gibHours),
      platinumMicros: micros,
    })
    .onConflictDoUpdate({
      target: [storageCharges.feed, storageCharges.resourceKind, storageCharges.resourceId, storageCharges.usageDay],
      set: { gibHours: String(gibHours), platinumMicros: micros, updatedAt: new Date() },
    })
    .returning(ROW_COLUMNS);
  if (!raw) throw new Error('storage charge row was not written');
  return toStoredRow(raw);
}

async function recordReading(id: string, gibHours: number, micros: number): Promise<void> {
  await db
    .update(storageCharges)
    .set({ gibHours: String(gibHours), platinumMicros: micros, updatedAt: new Date() })
    .where(
      and(
        eq(storageCharges.id, id),
        or(sql`${storageCharges.gibHours} <> ${String(gibHours)}::numeric`, sql`${storageCharges.platinumMicros} <> ${micros}`),
      ),
    );
}

async function markPending(id: string, seq: number, gibHours: number, amountUsd: number): Promise<void> {
  const updated = await db
    .update(storageCharges)
    .set({ pendingGibHours: String(gibHours), pendingUsd: String(amountUsd), updatedAt: new Date() })
    .where(and(eq(storageCharges.id, id), eq(storageCharges.chargeSeq, seq), sql`${storageCharges.pendingUsd} is null`))
    .returning({ id: storageCharges.id });
  // Another process moved the row first (a leadership flap): stop, the next tick reads it fresh.
  if (!updated.length) throw new Error('storage charge row changed under this tick');
}

async function finalizeCharge(id: string, seq: number, gibHours: number, amountUsd: number): Promise<void> {
  await db
    .update(storageCharges)
    .set({
      chargedGibHours: String(gibHours),
      chargedUsd: sql`${storageCharges.chargedUsd} + ${String(amountUsd)}::numeric`,
      chargeSeq: seq,
      pendingGibHours: null,
      pendingUsd: null,
      updatedAt: new Date(),
    })
    .where(and(eq(storageCharges.id, id), eq(storageCharges.chargeSeq, seq - 1)));
}

async function markWaived(id: string, waived: boolean): Promise<void> {
  await db.update(storageCharges).set({ waived, updatedAt: new Date() }).where(eq(storageCharges.id, id));
}

const UNATTRIBUTED = (reason: UnattributedReason, volumeName: string | null = null): StorageOwner => ({
  accountId: null,
  projectId: null,
  sessionId: null,
  driveId: null,
  volumeName,
  unattributedReason: reason,
});

/**
 * The owner of every resource that has no row for this day yet: first the
 * owner its row of an earlier day recorded, then the database by volume id,
 * then Platinum's name for the volume. A resource missing from the map waits
 * for the next tick (the per-tick name lookups ran out).
 */
export async function resolveOwners(
  feed: StorageFeed,
  deps: Pick<StorageChargeDeps, 'volumeName'>,
  resources: PlatinumVolumeUsageResource[],
  lookups: { left: number },
): Promise<Map<string, StorageOwner>> {
  const owners = new Map<string, StorageOwner>();
  if (!resources.length) return owners;

  // 1. An earlier day's row: one lookup per volume for its whole life.
  const earlier = await db.execute(sql`
    SELECT DISTINCT ON (resource_kind, resource_id)
           resource_kind, resource_id, account_id, project_id, session_id, drive_id, volume_name, unattributed_reason
      FROM kortix.storage_charges
     WHERE feed = ${feed.name} AND resource_id = ANY(${sql.param(resources.map((r) => r.resource_id))}::text[])
     ORDER BY resource_kind, resource_id, usage_day DESC`);
  for (const r of earlier as unknown as Array<Record<string, string | null>>) {
    // A deleted account or project was set null on the earlier row: the volume is now unattributed.
    owners.set(rowKey({ resource_kind: r.resource_kind as string, resource_id: r.resource_id as string }), {
      accountId: r.account_id ?? null,
      projectId: r.project_id ?? null,
      sessionId: r.session_id ?? null,
      driveId: r.drive_id ?? null,
      volumeName: r.volume_name ?? null,
      unattributedReason: r.account_id ? null : ((r.unattributed_reason as UnattributedReason | null) ?? 'owner_gone'),
    });
  }
  const pending = resources.filter((r) => !owners.has(rowKey(r)));

  for (const r of pending.filter((r) => r.resource_kind === 'volume_snapshot')) {
    owners.set(rowKey(r), UNATTRIBUTED('unsupported_kind'));
  }

  // 2. Scratch disks: the resource id is the box's Platinum id.
  const scratch = pending.filter((r) => r.resource_kind === 'scratch');
  if (scratch.length) {
    const boxes = await db
      .select({ externalId: sessionSandboxes.externalId, accountId: sessionSandboxes.accountId, projectId: sessionSandboxes.projectId, sessionId: sessionSandboxes.sessionId })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.provider, 'platinum'), inArray(sessionSandboxes.externalId, scratch.map((r) => r.resource_id))));
    const byId = new Map(boxes.map((b) => [b.externalId, b]));
    for (const r of scratch) {
      const box = byId.get(r.resource_id);
      owners.set(
        rowKey(r),
        box
          ? { accountId: box.accountId, projectId: box.projectId ?? null, sessionId: box.sessionId, driveId: null, volumeName: null, unattributedReason: null }
          : UNATTRIBUTED('not_kortix'),
      );
    }
  }

  // 3. Volumes: a drive that recorded the volume id, else Platinum's name.
  const volumes = pending.filter((r) => r.resource_kind === 'volume');
  if (!volumes.length) return owners;
  const byVolumeId = await db
    .select({ driveId: drives.driveId, accountId: drives.accountId, projectId: drives.projectId, volumeId: drives.platinumVolumeId, name: drives.platinumVolumeName })
    .from(drives)
    .where(inArray(drives.platinumVolumeId, volumes.map((r) => r.resource_id)));
  const driveById = new Map(byVolumeId.map((d) => [d.volumeId, d]));
  const named: Array<{ resource: PlatinumVolumeUsageResource; name: string }> = [];
  for (const r of volumes) {
    const drive = driveById.get(r.resource_id);
    if (drive) {
      owners.set(rowKey(r), { accountId: drive.accountId, projectId: drive.projectId ?? null, sessionId: null, driveId: drive.driveId, volumeName: drive.name, unattributedReason: null });
      continue;
    }
    if (lookups.left <= 0) continue;
    lookups.left -= 1;
    const name = await deps.volumeName(feed, r.resource_id);
    if (!name) owners.set(rowKey(r), UNATTRIBUTED('volume_gone'));
    else named.push({ resource: r, name });
  }
  if (!named.length) return owners;

  const driveNames = named.filter((n) => classifyVolumeName(n.name).kind === 'drive').map((n) => n.name);
  const driveRows = driveNames.length
    ? await db
        .select({ driveId: drives.driveId, accountId: drives.accountId, projectId: drives.projectId, name: drives.platinumVolumeName, move: drives.platinumVolumeMove })
        .from(drives)
        .where(or(inArray(drives.platinumVolumeName, driveNames), inArray(sql<string>`${drives.platinumVolumeMove}->>'from_name'`, driveNames)))
    : [];
  const driveByName = new Map<string, (typeof driveRows)[number]>();
  for (const d of driveRows) {
    driveByName.set(d.name, d);
    // A region move's old volume, until it is purged, belongs to the same drive.
    if (d.move?.from_name) driveByName.set(d.move.from_name, d);
  }
  const sessionIds = named.flatMap((n) => {
    const c = classifyVolumeName(n.name);
    return c.kind === 'workspace' ? [c.sessionId] : [];
  });
  const sessions = sessionIds.length
    ? await db
        .select({ sessionId: projectSessions.sessionId, accountId: projectSessions.accountId, projectId: projectSessions.projectId })
        .from(projectSessions)
        .where(inArray(projectSessions.sessionId, sessionIds))
    : [];
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));

  for (const { resource, name } of named) {
    const c = classifyVolumeName(name);
    if (c.kind === 'drive') {
      const d = driveByName.get(name);
      owners.set(
        rowKey(resource),
        d ? { accountId: d.accountId, projectId: d.projectId ?? null, sessionId: null, driveId: d.driveId, volumeName: name, unattributedReason: null } : UNATTRIBUTED('owner_gone', name),
      );
    } else if (c.kind === 'workspace') {
      const s = sessionById.get(c.sessionId);
      owners.set(
        rowKey(resource),
        s ? { accountId: s.accountId, projectId: s.projectId, sessionId: s.sessionId, driveId: null, volumeName: name, unattributedReason: null } : UNATTRIBUTED('owner_gone', name),
      );
    } else {
      owners.set(rowKey(resource), UNATTRIBUTED('not_kortix', name));
    }
  }
  return owners;
}
