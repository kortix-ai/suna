/**
 * The disk of a box that is not running, billed exactly as Platinum bills it
 * to Kortix (platinum apps/api/src/billing.ts, the uptime sampler):
 *
 * | Box state                 | Platinum bills the disk_gb at          | Kortix charges it from     |
 * |---------------------------|----------------------------------------|----------------------------|
 * | running, stopping         | pricing.storage_gb_hour_micros (72 µ$) | compute metering (running) |
 * | stopped                   | pricing.storage_gb_hour_micros (72 µ$) | here, kind `box_disk`      |
 * | archived                  | archived_storage_gb_hour_micros (36 µ$)| here, `box_disk_archived`  |
 * | boots from a root volume  | nothing (the volume bills instead)     | nothing                    |
 *
 * Platinum no longer lists a box's disk in GET /v1/billing/events (its
 * `sandbox.uptime` rows moved to compacted segments on 2026-09-10), and its
 * per-box usage readers are capped at 1,000 boxes or cost one call per box.
 * So Kortix meters the disk itself, from the box list Platinum serves:
 * `stoppedAt` is when the box stopped, `billableSince` is when an archived box
 * became archived (trg_sandbox_billable_since), `diskGb` is the size billed,
 * `root_disk` marks a root-volume box.
 *
 * Each tick reads the stopped boxes, and the archived boxes every
 * ARCHIVED_LIST_INTERVAL_MS and on the first tick of each UTC day (there are
 * thousands, and nothing about them changes). A box's metered time runs from
 * its watermark (the latest `metered_through` of its rows) to now, split per
 * UTC day and per rate, into kortix.storage_charges rows. It never starts
 * before the end of the box's last Kortix compute window, and a box whose
 * compute window is still open is skipped: compute metering bills it as
 * running, so no hour is billed twice.
 *
 * A day is charged once the box is metered past the day's end (or a day
 * later, when the box left the lists: started, deleted), through the same
 * pending/sequence/key discipline as volume storage (chargeStorageRow).
 *
 * Attribution: box → session_sandboxes, app_runtimes or project_monitor_boxes
 * → account and project. A box with this deployment's create-time marker and
 * no row is recorded unattributed (`owner_gone`): Kortix's own cost. A box of
 * another deployment in the shared org is not this deployment's to record.
 * An account with no credit account, or the `storageBilling: false` override,
 * is waived. The first tick of a feed starts the meter: never retroactive.
 *
 * Bounded error, documented: an archived box that is unarchived or deleted
 * between two archived listings is not metered for that part of its last
 * interval (at most ARCHIVED_LIST_INTERVAL_MS, Kortix's cost). The minutes a
 * box spends `archiving` are metered at the stopped rate.
 */
import { appDeployments, appRuntimes, apps, projectMonitorBoxes, sessionSandboxes, storageCharges } from '@kortix/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { config } from '../../config';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { logger } from '../../lib/logger';
import { PLATINUM_LIST_PRICE_MICROS } from '../../platform/providers/compute-rates';
import { providerBoxBelongsToThisInstance } from '../../platform/providers/platinum';
import { sandboxOwnershipMarker } from '../../platform/sandbox-ownership';
import { db } from '../../shared/db';
import { platinumJson } from '../../shared/platinum';
import {
  STORAGE_ROW_COLUMNS,
  type StorageFeed,
  type StorageOwner,
  type StorageSettleDeps,
  accountStorageBilled,
  addDays,
  chargeStorageRow,
  readPlatformSetting,
  storageChargeDeps,
  toStoredRow,
  utcDay,
  writePlatformSetting,
} from './storage-charges';
import { settleAndCheckAutoTopup } from './wallet-debits';

export const BOX_DISK_START_KEY = 'platinum.box_disk.start';
export const BOX_DISK_ARCHIVED_LISTED_KEY = 'platinum.box_disk.archived_listed';
/** How often the archived boxes are listed (and on the first tick of each UTC day). */
export const ARCHIVED_LIST_INTERVAL_MS = 6 * 3_600_000;
/** Days metered and charged at most: a worker down longer does not bill the gap. */
export const BOX_DISK_MAX_DAYS = 14;
const DAY_MS = 86_400_000;
/** Platinum's largest list page, and a bound on pages per listing (40,000 boxes). */
const LIST_PAGE_LIMIT = 200;
const MAX_LIST_PAGES = 200;
const ID_CHUNK = 1000;

export type BoxDiskKind = 'box_disk' | 'box_disk_archived';
const BOX_DISK_KINDS: BoxDiskKind[] = ['box_disk', 'box_disk_archived'];

/** What Kortix pays Platinum per GB-hour of a box's disk_gb, in µ$ (× PLATINUM_MARKUP is the customer rate). */
const PLATINUM_DISK_MICROS: Record<BoxDiskKind, number> = {
  box_disk: PLATINUM_LIST_PRICE_MICROS.diskGbHour,
  box_disk_archived: PLATINUM_LIST_PRICE_MICROS.archivedDiskGbHour,
};

/** The fields of a Platinum list row the meter reads (GET /v1/sandboxes). */
export interface PlatinumBox {
  id: string;
  state: string;
  diskGb: number | null;
  stoppedAt?: string | null;
  billableSince?: string | null;
  /** Non-null when the box boots from a root volume: Platinum bills its disk 0. */
  root_disk?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface BoxDiskSpan {
  kind: BoxDiskKind;
  fromMs: number;
  toMs: number;
}

export interface BoxDiskSlice extends BoxDiskSpan {
  day: string;
}

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * The disk time of one box, from `fromMs` to `nowMs`, by rate. Since the box
 * last stopped its state can only have gone stopped → archived: a start would
 * have changed `stoppedAt`, and leaving `archived` re-stamps `billableSince`.
 *
 * - stopped: from the later of `stoppedAt` and `billableSince` (a box restored
 *   from an archive without a start is stopped from its restore).
 * - archived: stopped from `stoppedAt` to `billableSince`, then archived.
 * - any other state: nothing (running is compute metering's; a transitional
 *   state is not billed by Platinum).
 */
export function boxDiskSpans(
  box: Pick<PlatinumBox, 'state' | 'stoppedAt' | 'billableSince'>,
  fromMs: number,
  nowMs: number,
): BoxDiskSpan[] {
  const stoppedAt = ms(box.stoppedAt);
  const since = ms(box.billableSince);
  const spans: BoxDiskSpan[] = [];
  const push = (kind: BoxDiskKind, from: number, to: number) => {
    if (to > from) spans.push({ kind, fromMs: from, toMs: to });
  };
  if (box.state === 'stopped') {
    push('box_disk', Math.max(fromMs, stoppedAt ?? fromMs, since ?? fromMs), nowMs);
  } else if (box.state === 'archived') {
    const archivedAt = since ?? fromMs;
    if (stoppedAt !== null) push('box_disk', Math.max(fromMs, stoppedAt), Math.min(archivedAt, nowMs));
    push('box_disk_archived', Math.max(fromMs, archivedAt), nowMs);
  }
  return spans;
}

/** Split spans at each UTC midnight: one row per (rate, day). */
export function splitByUtcDay(spans: BoxDiskSpan[]): BoxDiskSlice[] {
  const out: BoxDiskSlice[] = [];
  for (const span of spans) {
    for (let from = span.fromMs; from < span.toMs; ) {
      const to = Math.min(span.toMs, (Math.floor(from / DAY_MS) + 1) * DAY_MS);
      out.push({ kind: span.kind, fromMs: from, toMs: to, day: utcDay(from) });
      from = to;
    }
  }
  return out;
}

/** GB-hours of `diskGb` over a slice. */
export function sliceGbHours(diskGb: number, slice: Pick<BoxDiskSpan, 'fromMs' | 'toMs'>): number {
  return (diskGb * (slice.toMs - slice.fromMs)) / 3_600_000;
}

/**
 * Where a box's metering starts: never before the feed's start or the open-day
 * floor, never before its watermark, never inside a Kortix compute window.
 * Null when its compute window is still open (compute metering bills it).
 */
export function boxMeterFrom(input: {
  startMs: number;
  nowMs: number;
  watermarkMs: number | null;
  computeWindow: { endedAtMs: number | null } | null;
}): number | null {
  if (input.computeWindow && input.computeWindow.endedAtMs === null) return null;
  return Math.max(
    input.startMs,
    input.nowMs - BOX_DISK_MAX_DAYS * DAY_MS,
    input.watermarkMs ?? -Infinity,
    input.computeWindow?.endedAtMs ?? -Infinity,
  );
}

export interface BoxOwner extends StorageOwner {
  /** The Kortix id the box's compute windows carry (sandbox_compute_sessions.sandbox_id). */
  kortixSandboxId: string | null;
}

export interface BoxDiskDeps extends StorageSettleDeps {
  feeds(): StorageFeed[];
  /** Every box of the feed's own region in this state (GET /v1/sandboxes?state=…&regions=local). */
  listBoxes(feed: StorageFeed, state: 'stopped' | 'archived'): Promise<PlatinumBox[]>;
  /** A test for this deployment's create-time marker (kortix.managed, kortix.env, kortix.instance). */
  ownership(): Promise<(box: PlatinumBox) => boolean>;
  readSetting(key: string): Promise<unknown>;
  writeSetting(key: string, value: Record<string, unknown>): Promise<void>;
  now(): number;
}

interface PlatinumBoxPage {
  rows?: PlatinumBox[];
  has_more?: boolean;
}

export const boxDiskDeps: BoxDiskDeps = {
  feeds: () => storageChargeDeps.feeds(),
  async listBoxes(feed, state) {
    const boxes = new Map<string, PlatinumBox>();
    for (let page = 0, offset = 0; page < MAX_LIST_PAGES; page++, offset += LIST_PAGE_LIMIT) {
      // regions=local: this control plane's boxes only (each region is its own feed), and no 10,000-row merge cap.
      const query = new URLSearchParams({
        paginated: 'true',
        limit: String(LIST_PAGE_LIMIT),
        offset: String(offset),
        state,
        regions: 'local',
      });
      const body = await platinumJson<PlatinumBoxPage>(`/v1/sandboxes?${query}`, {}, feed.origin);
      const rows = body.rows ?? [];
      // Newest first: a box created mid-listing shifts the pages, so one can repeat. Its watermark
      // makes a skipped one whole on the next listing.
      for (const row of rows) if (row?.id) boxes.set(row.id, row);
      if (!body.has_more || rows.length === 0) break;
    }
    return [...boxes.values()];
  },
  async ownership() {
    const marker = await sandboxOwnershipMarker();
    return (box) => {
      const metadata = box.metadata ?? {};
      return (
        metadata['kortix.managed'] === marker &&
        String(metadata['kortix.env'] ?? '') === config.INTERNAL_KORTIX_ENV &&
        providerBoxBelongsToThisInstance(metadata['kortix.instance'])
      );
    };
  },
  readSetting: readPlatformSetting,
  writeSetting: writePlatformSetting,
  // Metered always, charged only behind the switch: off records every row waived.
  storageBilled: async (accountId) => config.KORTIX_BOX_DISK_CHARGE_ENABLED && (await accountStorageBilled(accountId)),
  settle: settleAndCheckAutoTopup,
  now: () => Date.now(),
};

export interface BoxDiskResult {
  /** Boxes listed stopped or archived with a disk Platinum bills (another deployment's included). */
  boxes: number;
  /** Of those, metered this tick. */
  metered: number;
  /** Skipped: Kortix still bills them as running. */
  running: number;
  /** Skipped: another deployment's. */
  foreign: number;
  gbHours: number;
  charged: number;
  chargedUsd: number;
  unattributed: number;
  waived: number;
  failed: number;
}

/** Meter and charge the disk of every stopped or archived box since the last tick. */
export async function syncBoxDiskCharges(deps: BoxDiskDeps = boxDiskDeps): Promise<BoxDiskResult> {
  const total: BoxDiskResult = {
    boxes: 0,
    metered: 0,
    running: 0,
    foreign: 0,
    gbHours: 0,
    charged: 0,
    chargedUsd: 0,
    unattributed: 0,
    waived: 0,
    failed: 0,
  };
  // One entitlement read per account per tick: a day of thousands of archived boxes repeats accounts.
  const billed = new Map<string, Promise<boolean>>();
  const settleDeps: StorageSettleDeps = {
    settle: deps.settle,
    storageBilled: (accountId) => {
      let answer = billed.get(accountId);
      if (!answer) billed.set(accountId, (answer = deps.storageBilled(accountId)));
      return answer;
    },
  };
  for (const feed of deps.feeds()) {
    try {
      await meterFeed(feed, deps, total);
    } catch (error) {
      logger.error('[box-disk-billing] metering failed; the next tick resumes from each watermark', {
        feed: feed.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await chargeEndedDays(feed.name, utcDay(deps.now()), settleDeps, total);
    } catch (error) {
      logger.error('[box-disk-billing] charging failed; the next tick retries with the same keys', {
        feed: feed.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return total;
}

function readAt(value: unknown): number | null {
  return ms((value as { at?: string } | null)?.at ?? null);
}

async function meterFeed(feed: StorageFeed, deps: BoxDiskDeps, total: BoxDiskResult): Promise<void> {
  const nowMs = deps.now();
  const startKey = `${BOX_DISK_START_KEY}.${feed.name}`;
  const listedKey = `${BOX_DISK_ARCHIVED_LISTED_KEY}.${feed.name}`;
  const startMs = readAt(await deps.readSetting(startKey));
  if (startMs === null) {
    // Never retroactive: disk time is metered from this instant on.
    await deps.writeSetting(startKey, { at: new Date(nowMs).toISOString() });
    return;
  }
  const listedMs = readAt(await deps.readSetting(listedKey));
  const listArchived = listedMs === null || nowMs - listedMs >= ARCHIVED_LIST_INTERVAL_MS || utcDay(listedMs) < utcDay(nowMs);

  const listed = [
    ...(await deps.listBoxes(feed, 'stopped')),
    ...(listArchived ? await deps.listBoxes(feed, 'archived') : []),
  ];
  const boxes = listed.filter(
    (b) => (b.state === 'stopped' || b.state === 'archived') && Number(b.diskGb) > 0 && (b.root_disk === null || b.root_disk === undefined),
  );
  total.boxes += boxes.length;

  const owners = await resolveBoxOwners(boxes.map((b) => b.id));
  const windows = await latestComputeWindows([...owners.values()].map((o) => o.kortixSandboxId).filter((id): id is string => !!id));
  const mine = await deps.ownership();
  for (const box of boxes) {
    let owner: BoxOwner | undefined = owners.get(box.id);
    if (!owner) {
      if (!mine(box)) {
        total.foreign += 1;
        continue;
      }
      owner = { ...UNATTRIBUTED_BOX };
    }
    const window = owner.kortixSandboxId ? (windows.get(owner.kortixSandboxId) ?? null) : null;
    if (window && window.endedAtMs === null) {
      total.running += 1;
      continue;
    }
    try {
      const gbHours = await meterBox(feed.name, box, owner, { startMs, nowMs, computeWindow: window });
      if (gbHours > 0) {
        total.metered += 1;
        total.gbHours += gbHours;
        // Kortix's own cost: recorded on the row, never charged.
        if (!owner.accountId) total.unattributed += 1;
      }
    } catch (error) {
      total.failed += 1;
      logger.error('[box-disk-billing] metering a box failed; the next tick resumes from its watermark', {
        feed: feed.name,
        box: box.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Only a listing that completed moves the clock: a failed one is read again next tick.
  if (listArchived) await deps.writeSetting(listedKey, { at: new Date(nowMs).toISOString() });
}

const UNATTRIBUTED_BOX: BoxOwner = {
  accountId: null,
  projectId: null,
  sessionId: null,
  driveId: null,
  volumeName: null,
  unattributedReason: 'owner_gone',
  kortixSandboxId: null,
};

/**
 * Add one box's disk time since its watermark to its day rows. One
 * transaction, under a lock on the box: the watermark read and the rows it
 * moves commit together, so a replayed or concurrent tick meters no second
 * of disk twice. Returns the GB-hours added.
 */
async function meterBox(
  feed: string,
  box: PlatinumBox,
  owner: BoxOwner,
  at: { startMs: number; nowMs: number; computeWindow: { endedAtMs: number | null } | null },
): Promise<number> {
  const diskGb = Number(box.diskGb);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`box-disk:${feed}:${box.id}`}, 0))`);
    const [mark] = (await tx.execute(sql`
      SELECT max(metered_through) AS through
        FROM kortix.storage_charges
       WHERE feed = ${feed} AND resource_kind IN ('box_disk', 'box_disk_archived') AND resource_id = ${box.id}`)) as unknown as Array<{
      through: string | Date | null;
    }>;
    const watermarkMs = mark?.through ? new Date(mark.through).getTime() : null;
    const fromMs = boxMeterFrom({ startMs: at.startMs, nowMs: at.nowMs, watermarkMs, computeWindow: at.computeWindow });
    if (fromMs === null) return 0;
    let added = 0;
    for (const slice of splitByUtcDay(boxDiskSpans(box, fromMs, at.nowMs))) {
      const gbHours = sliceGbHours(diskGb, slice);
      if (!(gbHours > 0)) continue;
      added += gbHours;
      const micros = Math.round(gbHours * PLATINUM_DISK_MICROS[slice.kind]);
      const through = new Date(slice.toMs).toISOString();
      await tx
        .insert(storageCharges)
        .values({
          feed,
          resourceKind: slice.kind,
          resourceId: box.id,
          usageDay: slice.day,
          accountId: owner.accountId,
          projectId: owner.projectId,
          sessionId: owner.sessionId,
          unattributedReason: owner.accountId ? null : (owner.unattributedReason ?? 'owner_gone'),
          gibHours: String(gbHours),
          platinumMicros: micros,
          meteredThrough: through,
        })
        .onConflictDoUpdate({
          target: [storageCharges.feed, storageCharges.resourceKind, storageCharges.resourceId, storageCharges.usageDay],
          set: {
            gibHours: sql`${storageCharges.gibHours} + excluded.gib_hours`,
            platinumMicros: sql`${storageCharges.platinumMicros} + excluded.platinum_micros`,
            meteredThrough: sql`greatest(${storageCharges.meteredThrough}, excluded.metered_through)`,
            updatedAt: new Date(),
          },
        });
    }
    return added;
  });
}

/**
 * Charge every ended day whose metering is complete: the box is metered past
 * the day's end, or the day is two days old (the box left the lists).
 */
async function chargeEndedDays(feed: string, today: string, deps: StorageSettleDeps, total: BoxDiskResult): Promise<void> {
  const rows = await db
    .select(STORAGE_ROW_COLUMNS)
    .from(storageCharges)
    .where(
      and(
        eq(storageCharges.feed, feed),
        inArray(storageCharges.resourceKind, BOX_DISK_KINDS),
        sql`${storageCharges.usageDay} < ${today}::date`,
        sql`${storageCharges.usageDay} >= ${addDays(today, -BOX_DISK_MAX_DAYS)}::date`,
        isNotNull(storageCharges.accountId),
        eq(storageCharges.waived, false),
        sql`(${storageCharges.gibHours} > ${storageCharges.chargedGibHours} OR ${storageCharges.pendingUsd} IS NOT NULL)`,
        // Complete: the box is metered past the day's end (on this row, or on the row of the rate it moved
        // to, e.g. archived at 23:36), or the day is two days old (the box left the lists: started, deleted).
        sql`(${qualifiedColumn(storageCharges.usageDay)} < ${addDays(today, -1)}::date
             OR (SELECT max(o.metered_through) FROM kortix.storage_charges o
                  WHERE o.feed = ${qualifiedColumn(storageCharges.feed)}
                    AND o.resource_id = ${qualifiedColumn(storageCharges.resourceId)}
                    AND o.resource_kind IN ('box_disk', 'box_disk_archived'))
                >= ((${qualifiedColumn(storageCharges.usageDay)} + 1)::timestamp AT TIME ZONE 'UTC'))`,
      ),
    );
  for (const raw of rows) {
    const row = toStoredRow(raw);
    try {
      const outcome = await chargeStorageRow(feed, row, row.gibHours, deps);
      if (outcome === 'unattributed') total.unattributed += 1;
      else if (outcome === 'waived') total.waived += 1;
      else if (typeof outcome === 'number') {
        total.charged += 1;
        total.chargedUsd += outcome;
      }
    } catch (error) {
      total.failed += 1;
      logger.error('[box-disk-billing] charge failed; the next tick retries it with the same key', {
        feed,
        box: row.resourceId,
        day: row.usageDay,
        kind: row.resourceKind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

/** Each box's owner, by the Platinum id a session, App or monitor row recorded. */
export async function resolveBoxOwners(boxIds: string[]): Promise<Map<string, BoxOwner>> {
  const owners = new Map<string, BoxOwner>();
  const base = { driveId: null, volumeName: null, unattributedReason: null };
  for (const ids of chunks([...new Set(boxIds)])) {
    const sessionBoxes = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sandboxId: sessionSandboxes.sandboxId,
        accountId: sessionSandboxes.accountId,
        projectId: sessionSandboxes.projectId,
        sessionId: sessionSandboxes.sessionId,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.provider, 'platinum'), inArray(sessionSandboxes.externalId, ids)));
    for (const b of sessionBoxes) {
      if (!b.externalId) continue;
      owners.set(b.externalId, { ...base, accountId: b.accountId, projectId: b.projectId, sessionId: b.sessionId, kortixSandboxId: b.sandboxId });
    }
    const appBoxes = await db
      .select({ externalId: appRuntimes.externalId, runtimeId: appRuntimes.runtimeId, accountId: appRuntimes.accountId, projectId: apps.projectId })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appDeployments.deploymentId, appRuntimes.deploymentId))
      .innerJoin(apps, eq(apps.appId, appDeployments.appId))
      .where(and(eq(appRuntimes.provider, 'platinum'), inArray(appRuntimes.externalId, ids)));
    for (const b of appBoxes) {
      if (owners.has(b.externalId)) continue;
      owners.set(b.externalId, { ...base, accountId: b.accountId, projectId: b.projectId ?? null, sessionId: null, kortixSandboxId: b.runtimeId });
    }
    const monitorBoxes = await db
      .select({ externalId: projectMonitorBoxes.externalId, boxId: projectMonitorBoxes.boxId, accountId: projectMonitorBoxes.accountId, projectId: projectMonitorBoxes.projectId })
      .from(projectMonitorBoxes)
      .where(and(eq(projectMonitorBoxes.provider, 'platinum'), inArray(projectMonitorBoxes.externalId, ids)));
    for (const b of monitorBoxes) {
      if (!b.externalId || owners.has(b.externalId)) continue;
      owners.set(b.externalId, { ...base, accountId: b.accountId, projectId: b.projectId, sessionId: null, kortixSandboxId: b.boxId });
    }
  }
  return owners;
}

/** The latest compute window of each Kortix box id: open (endedAtMs null), or where it ended. */
export async function latestComputeWindows(kortixIds: string[]): Promise<Map<string, { endedAtMs: number | null }>> {
  const windows = new Map<string, { endedAtMs: number | null }>();
  for (const ids of chunks([...new Set(kortixIds)])) {
    const rows = (await db.execute(sql`
      SELECT DISTINCT ON (sandbox_id) sandbox_id, ended_at, last_billed_at
        FROM kortix.sandbox_compute_sessions
       WHERE sandbox_id = ANY(${sql.param(ids)}::uuid[])
       ORDER BY sandbox_id, started_at DESC`)) as unknown as Array<{
      sandbox_id: string;
      ended_at: string | Date | null;
      last_billed_at: string | Date | null;
    }>;
    for (const r of rows) {
      if (r.ended_at === null) {
        windows.set(r.sandbox_id, { endedAtMs: null });
        continue;
      }
      // A window settles through last_billed_at; a terminal row can close at its cursor.
      const ended = Math.max(new Date(r.ended_at).getTime(), r.last_billed_at ? new Date(r.last_billed_at).getTime() : -Infinity);
      windows.set(r.sandbox_id, { endedAtMs: ended });
    }
  }
  return windows;
}
