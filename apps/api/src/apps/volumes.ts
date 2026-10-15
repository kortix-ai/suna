/**
 * App volumes (on Platinum volumes). A volume belongs to one
 * machine of a process group and outlives every instance of it: a release swap
 * stops the old instance, detaches the volume (Platinum commits it) and mounts
 * it on the new instance at create.
 *
 * RULE 1, single writer: two read-write mounts of one volume merge file by
 * file and silently drop one side (the 2026-10-10 spike lost ~20,800 Postgres
 * rows that way). `app_volumes.attached_runtime_id` is the lock: an instance
 * takes it (compare-and-set from null) before its box is created and gives it
 * back only after its box is stopped and the volume detached, or the box is
 * gone. Never two live instances on one volume.
 *
 * Snapshots are Platinum commits pinned by a tag: `daily-YYYYMMDD` (one per
 * day, automatic), `manual-YYYYMMDD-HHMMSS` and `final-…` (taken at destroy).
 * Tags older than the volume's `snapshot_retention_days` are removed; a
 * destroyed volume is purged after `VOLUME_PURGE_DAYS`.
 */
import { appRuntimes, appVolumes } from '@kortix/db';
import { MAX_VOLUME_GB, type AppMount } from '@kortix/shared/app-config';
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { AppVolumeStoreError, appVolumeStore, type AppVolumeInfo } from './volume-store';

export type AppVolumeRow = typeof appVolumes.$inferSelect;

/** Days a destroyed volume (and its final snapshot) is kept before it is purged. */
export const VOLUME_PURGE_DAYS = 7;
const VOLUME_NAME = /^[a-z0-9_]{1,30}$/;
const SNAPSHOT_TAG = /^(daily|manual|final)-(\d{8})(?:-\d{6})?$/;
const DETACH_ATTEMPTS = 4;

export class AppVolumeError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) {
    super(message);
    this.name = 'AppVolumeError';
  }
}

/** Volumes live on Platinum only. */
export function appVolumesSupported(provider: string): boolean {
  return provider === 'platinum';
}

export type ReleaseProviderChoice =
  | { ok: true; provider: string | null }
  | { ok: false; provider: string };

/**
 * The provider a release deploys to. A named provider wins. Otherwise a
 * release with mounts needs Platinum, so it takes Platinum when configured;
 * else an App keeps the provider of its latest release; else `null` leaves
 * the platform default to the deployment worker.
 */
export function chooseReleaseProvider(input: {
  requested?: string | null;
  hasMounts: boolean;
  previous?: string | null;
  platinumEnabled: boolean;
  platformDefault: string;
}): ReleaseProviderChoice {
  const { requested, hasMounts, previous, platinumEnabled, platformDefault } = input;
  let provider: string | null = requested ?? null;
  if (!provider && hasMounts && platinumEnabled) provider = 'platinum';
  if (!provider) provider = previous ?? null;
  if (hasMounts && !appVolumesSupported(provider ?? platformDefault)) {
    return { ok: false, provider: provider ?? platformDefault };
  }
  return { ok: true, provider };
}

/** The Platinum volume name: environments share a provider org, not a database. */
export function appVolumeExternalId(volumeId: string): string {
  const env = config.INTERNAL_KORTIX_ENV.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'env';
  return `kapp-${env}-${volumeId}`;
}

function storeError(error: unknown): never {
  if (error instanceof AppVolumeStoreError && error.code === 'volume_busy') {
    throw new AppVolumeError(409, 'volume_attached', 'The volume is mounted on a machine; stop the machine first.');
  }
  throw error;
}

const live = (appId: string) => and(eq(appVolumes.appId, appId), isNull(appVolumes.deletedAt));

async function createVolume(input: {
  appId: string;
  accountId: string;
  name: string;
  group: string;
  machineId: string | null;
  sizeGb: number;
  retentionDays: number;
  forkOf?: { externalId: string; at: string };
}): Promise<AppVolumeRow> {
  const volumeId = crypto.randomUUID();
  const externalId = appVolumeExternalId(volumeId);
  const [row] = await db.insert(appVolumes).values({
    volumeId,
    appId: input.appId,
    accountId: input.accountId,
    name: input.name,
    processGroup: input.group,
    machineId: input.machineId,
    sizeGb: Math.min(MAX_VOLUME_GB, input.sizeGb),
    externalId,
    status: 'creating',
    snapshotRetentionDays: input.retentionDays,
  }).returning();
  try {
    if (input.forkOf) await appVolumeStore.fork(input.forkOf.externalId, externalId, input.forkOf.at);
    else await appVolumeStore.open(externalId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(appVolumes).set({ status: 'error', error: message.slice(0, 2000), deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(appVolumes.volumeId, volumeId));
    storeError(error);
  }
  const [ready] = await db.update(appVolumes).set({ status: 'ready', updatedAt: new Date() })
    .where(eq(appVolumes.volumeId, volumeId)).returning();
  return ready ?? row!;
}

/**
 * The volume a machine mounts: its own; else an unattached volume of the same
 * mount whose machine is gone (a new machine takes an unattached volume
 * of that name, so a lost machine never strands its data); else a new, empty
 * one of `initial_size_gb`.
 */
export async function ensureMachineVolume(input: {
  appId: string;
  accountId: string;
  mount: AppMount;
  group: string;
  machineId: string;
}): Promise<AppVolumeRow> {
  const [own] = await db.select().from(appVolumes)
    .where(and(live(input.appId), eq(appVolumes.machineId, input.machineId)))
    .limit(1);
  if (own) {
    if (own.status === 'ready') return own;
    await appVolumeStore.open(own.externalId).catch(storeError);
    const [ready] = await db.update(appVolumes).set({ status: 'ready', error: null, updatedAt: new Date() })
      .where(eq(appVolumes.volumeId, own.volumeId)).returning();
    return ready!;
  }
  const claimed = await db.execute(sql`
    update ${appVolumes} set machine_id = ${input.machineId}, updated_at = now()
    where volume_id = (
      select v.volume_id from ${appVolumes} v
      where v.app_id = ${input.appId} and v.deleted_at is null and v.status = 'ready'
        and v.name = ${input.mount.source} and v.process_group = ${input.group}
        and v.attached_runtime_id is null
        and (v.machine_id is null or not exists (
          select 1 from ${appRuntimes} r
          where coalesce(r.machine_id, r.runtime_id) = v.machine_id and r.status not in ('deleted', 'error')
        ))
      order by v.created_at
      limit 1
      for update skip locked
    )
    returning volume_id`);
  const claimedId = (claimed as unknown as Array<{ volume_id: string }>)[0]?.volume_id;
  if (claimedId) {
    const [row] = await db.select().from(appVolumes).where(eq(appVolumes.volumeId, claimedId)).limit(1);
    return row!;
  }
  return createVolume({
    appId: input.appId,
    accountId: input.accountId,
    name: input.mount.source,
    group: input.group,
    machineId: input.machineId,
    sizeGb: input.mount.initial_size_gb,
    retentionDays: input.mount.snapshot_retention_days,
  });
}

/** RULE 1: take the single-writer lock for an instance before its box exists. */
export async function acquireVolume(volumeId: string, runtimeId: string): Promise<void> {
  const [row] = await db.update(appVolumes).set({ attachedRuntimeId: runtimeId, updatedAt: new Date() })
    .where(and(
      eq(appVolumes.volumeId, volumeId),
      isNull(appVolumes.deletedAt),
      or(isNull(appVolumes.attachedRuntimeId), eq(appVolumes.attachedRuntimeId, runtimeId)),
    ))
    .returning({ volumeId: appVolumes.volumeId });
  if (!row) throw new AppVolumeError(409, 'volume_attached', `Volume ${volumeId} is attached to another machine.`);
}

/** Give the lock back. Only once the holder's box is stopped and detached, or gone. */
export async function releaseVolume(volumeId: string, runtimeId: string): Promise<void> {
  await db.update(appVolumes).set({ attachedRuntimeId: null, updatedAt: new Date() })
    .where(and(eq(appVolumes.volumeId, volumeId), eq(appVolumes.attachedRuntimeId, runtimeId)));
}

/** Release every lock held by runtimes that are gone (their boxes deleted). */
export async function releaseVolumesOf(runtimeIds: string[]): Promise<void> {
  if (runtimeIds.length === 0) return;
  await db.update(appVolumes).set({ attachedRuntimeId: null, updatedAt: new Date() })
    .where(sql`${appVolumes.attachedRuntimeId} in (${sql.join(runtimeIds.map((id) => sql`${id}`), sql`, `)})`);
}

/**
 * Detach a stopped instance's volume (Platinum commits a running mount first;
 * a stopped box committed at its stop), then release the lock. A commit still
 * flushing answers 503; it is retried.
 */
export async function detachVolume(
  runtime: { runtimeId: string; externalId: string; provider: string; volumeId: string | null },
  mountPath: string,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<void> {
  if (!runtime.volumeId) return;
  if (appVolumesSupported(runtime.provider)) {
    for (let attempt = 1; ; attempt++) {
      try {
        await appVolumeStore.detach(runtime.externalId, mountPath);
        break;
      } catch (error) {
        const retryable = error instanceof AppVolumeStoreError && error.status === 503;
        if (!retryable || attempt >= DETACH_ATTEMPTS) throw error;
        await sleep(1_000 * attempt);
      }
    }
  }
  await releaseVolume(runtime.volumeId, runtime.runtimeId);
}

/** Pre-create a volume: a later machine of its group with a mount of this name takes it. */
export async function createAppVolume(input: {
  appId: string;
  accountId: string;
  name: string;
  sizeGb: number;
  group?: string;
  retentionDays?: number;
}): Promise<AppVolumeRow> {
  if (!VOLUME_NAME.test(input.name)) {
    throw new AppVolumeError(400, 'volume_name_invalid', 'A volume name is 1-30 lowercase letters, digits or "_".');
  }
  if (!Number.isInteger(input.sizeGb) || input.sizeGb < 1 || input.sizeGb > MAX_VOLUME_GB) {
    throw new AppVolumeError(400, 'volume_size_invalid', `size_gb must be 1 to ${MAX_VOLUME_GB}.`);
  }
  return createVolume({
    appId: input.appId,
    accountId: input.accountId,
    name: input.name,
    group: input.group ?? 'app',
    machineId: null,
    sizeGb: input.sizeGb,
    retentionDays: input.retentionDays ?? 5,
  });
}

/**
 * Change a volume's snapshot retention, or confirm its size. Platinum allots
 * every volume a fixed size at create (it takes no size and cannot grow one),
 * so a size above that is refused and a size within it records the real one.
 */
export async function updateAppVolume(
  appId: string,
  volumeId: string,
  input: { sizeGb?: number; retentionDays?: number },
): Promise<AppVolumeRow> {
  const volume = await appVolume(appId, volumeId);
  let sizeGb: number | undefined;
  if (input.sizeGb !== undefined) {
    if (!Number.isInteger(input.sizeGb) || input.sizeGb > MAX_VOLUME_GB) {
      throw new AppVolumeError(400, 'volume_size_invalid', `size_gb must be at most ${MAX_VOLUME_GB}.`);
    }
    sizeGb = (await appVolumeStore.info(volume.externalId).catch(() => {
      throw new AppVolumeError(503, 'volume_size_unknown', 'The provider did not report the volume size; retry.');
    })).size_gb;
    if (input.sizeGb > sizeGb) {
      throw new AppVolumeError(400, 'volume_fixed_size', `The volume is ${sizeGb} GB, its fixed size: a volume cannot grow.`);
    }
  }
  if (input.retentionDays !== undefined && (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 60)) {
    throw new AppVolumeError(400, 'volume_retention_invalid', 'snapshot_retention_days must be 1 to 60.');
  }
  const [row] = await db.update(appVolumes).set({
    ...(sizeGb !== undefined ? { sizeGb } : {}),
    ...(input.retentionDays !== undefined ? { snapshotRetentionDays: input.retentionDays } : {}),
    updatedAt: new Date(),
  }).where(eq(appVolumes.volumeId, volume.volumeId)).returning();
  return row!;
}

/** A volume's live size, use and last commit from Platinum; null when unknown (not ready, or Platinum did not answer). */
export async function volumeInfo(volume: AppVolumeRow): Promise<AppVolumeInfo | null> {
  if (volume.status !== 'ready') return null;
  return appVolumeStore.info(volume.externalId).catch((error) => {
    logger.warn('[apps] volume info failed', { volumeId: volume.volumeId, error: String(error) });
    return null;
  });
}

export async function getAppVolume(appId: string, volumeId: string): Promise<AppVolumeRow> {
  return appVolume(appId, volumeId);
}

async function appVolume(appId: string, volumeId: string): Promise<AppVolumeRow> {
  const [row] = await db.select().from(appVolumes)
    .where(and(live(appId), eq(appVolumes.volumeId, volumeId)))
    .limit(1);
  if (!row) throw new AppVolumeError(404, 'volume_not_found', 'Volume not found.');
  return row;
}

export async function listAppVolumes(appId: string): Promise<AppVolumeRow[]> {
  return db.select().from(appVolumes).where(live(appId)).orderBy(asc(appVolumes.createdAt));
}

export interface AppVolumeSnapshot {
  snapshot_id: string;
  kind: 'daily' | 'manual' | 'final';
  commit_id: string;
  created_at: string;
}

function stamp(now: Date): { day: string; time: string } {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10).replaceAll('-', ''), time: iso.slice(11, 19).replaceAll(':', '') };
}

export async function listVolumeSnapshots(appId: string, volumeId: string): Promise<AppVolumeSnapshot[]> {
  const volume = await appVolume(appId, volumeId);
  return (await appVolumeStore.tags(volume.externalId))
    .filter((tag) => SNAPSHOT_TAG.test(tag.name))
    .map((tag) => ({
      snapshot_id: tag.name,
      kind: tag.name.split('-', 1)[0] as AppVolumeSnapshot['kind'],
      commit_id: tag.commit_id,
      created_at: tag.created_at,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Pin the volume's latest commit. A mounted volume's last ~1 s of writes may not be in it yet. */
export async function createVolumeSnapshot(appId: string, volumeId: string, now = new Date()): Promise<AppVolumeSnapshot> {
  const volume = await appVolume(appId, volumeId);
  const { day, time } = stamp(now);
  const tag = await appVolumeStore.tag(volume.externalId, `manual-${day}-${time}`);
  return { snapshot_id: tag.name, kind: 'manual', commit_id: tag.commit_id, created_at: tag.created_at };
}

/**
 * Make a snapshot the volume's head again (a new commit; nothing is lost).
 * The machine must be stopped and its volume detached: a mount never changes
 * under a running program.
 */
export async function restoreVolumeSnapshot(appId: string, volumeId: string, snapshotId: string): Promise<void> {
  const volume = await appVolume(appId, volumeId);
  if (volume.attachedRuntimeId) {
    throw new AppVolumeError(409, 'volume_attached', 'Stop the machine that mounts this volume before restoring it.');
  }
  if (!SNAPSHOT_TAG.test(snapshotId)) throw new AppVolumeError(400, 'snapshot_invalid', 'Unknown snapshot.');
  await appVolumeStore.restore(volume.externalId, snapshotId).catch(storeError);
}

/** A new, unattached volume of the App from a snapshot (or the head). */
export async function forkVolume(
  appId: string,
  volumeId: string,
  input: { name: string; snapshotId?: string },
): Promise<AppVolumeRow> {
  const volume = await appVolume(appId, volumeId);
  if (!VOLUME_NAME.test(input.name)) {
    throw new AppVolumeError(400, 'volume_name_invalid', 'A volume name is 1-30 lowercase letters, digits or "_".');
  }
  if (input.snapshotId && !SNAPSHOT_TAG.test(input.snapshotId)) throw new AppVolumeError(400, 'snapshot_invalid', 'Unknown snapshot.');
  return createVolume({
    appId,
    accountId: volume.accountId,
    name: input.name,
    group: volume.processGroup,
    machineId: null,
    sizeGb: volume.sizeGb,
    retentionDays: volume.snapshotRetentionDays,
    forkOf: { externalId: volume.externalId, at: input.snapshotId ?? 'head' },
  });
}

/**
 * Destroy (soft): a final snapshot, then the volume leaves the App. Its data
 * is purged after `VOLUME_PURGE_DAYS`. An attached volume is refused.
 */
export async function destroyVolume(appId: string, volumeId: string, now = new Date()): Promise<void> {
  const volume = await appVolume(appId, volumeId);
  if (volume.attachedRuntimeId) {
    throw new AppVolumeError(409, 'volume_attached', 'The volume is mounted on a machine; scale the machine down first.');
  }
  await softDelete(volume, now);
}

async function softDelete(volume: AppVolumeRow, now: Date): Promise<void> {
  const { day, time } = stamp(now);
  await appVolumeStore.tag(volume.externalId, `final-${day}-${time}`).catch((error) => {
    logger.warn('[apps] final volume snapshot failed', { volumeId: volume.volumeId, error: String(error) });
  });
  await db.update(appVolumes).set({
    status: 'destroying', machineId: null, attachedRuntimeId: null, deletedAt: now, updatedAt: now,
  }).where(eq(appVolumes.volumeId, volume.volumeId));
}

/** An App was deleted (its machines already removed): every volume leaves with it. */
export async function destroyAppVolumes(appId: string, now = new Date()): Promise<number> {
  const volumes = await db.select().from(appVolumes).where(live(appId));
  for (const volume of volumes) await softDelete(volume, now);
  return volumes.length;
}

/**
 * Maintenance: purge volumes destroyed more than `VOLUME_PURGE_DAYS` ago, take
 * each live volume's daily snapshot, and untag snapshots past its retention.
 */
export async function sweepAppVolumes(now = new Date(), limit = 100): Promise<{ purged: number; snapshotted: number; untagged: number; errors: number }> {
  let purged = 0;
  let snapshotted = 0;
  let untagged = 0;
  let errors = 0;
  const expired = await db.select().from(appVolumes).where(and(
    isNotNull(appVolumes.deletedAt),
    lt(appVolumes.deletedAt, new Date(now.getTime() - VOLUME_PURGE_DAYS * 86_400_000)),
    sql`${appVolumes.status} <> 'destroyed'`,
  )).limit(limit);
  for (const volume of expired) {
    try {
      await appVolumeStore.remove(volume.externalId);
      await db.update(appVolumes).set({ status: 'destroyed', updatedAt: now }).where(eq(appVolumes.volumeId, volume.volumeId));
      purged += 1;
    } catch (error) {
      errors += 1;
      logger.warn('[apps] volume purge failed; the next pass retries', { volumeId: volume.volumeId, error: String(error) });
    }
  }
  const { day } = stamp(now);
  const due = await db.select().from(appVolumes).where(and(
    isNull(appVolumes.deletedAt),
    eq(appVolumes.status, 'ready'),
    sql`coalesce(${appVolumes.metadata} ->> 'lastDailySnapshot', '') < ${day}`,
  )).orderBy(asc(appVolumes.updatedAt)).limit(limit);
  for (const volume of due) {
    try {
      await appVolumeStore.tag(volume.externalId, `daily-${day}`);
      snapshotted += 1;
      const cutoff = stamp(new Date(now.getTime() - volume.snapshotRetentionDays * 86_400_000)).day;
      for (const tag of await appVolumeStore.tags(volume.externalId)) {
        const match = SNAPSHOT_TAG.exec(tag.name);
        if (match && match[1] !== 'final' && match[2]! < cutoff) {
          await appVolumeStore.untag(volume.externalId, tag.name);
          untagged += 1;
        }
      }
      await db.update(appVolumes).set({
        metadata: sql`${appVolumes.metadata} || ${JSON.stringify({ lastDailySnapshot: day })}::jsonb`,
      }).where(eq(appVolumes.volumeId, volume.volumeId));
    } catch (error) {
      errors += 1;
      logger.warn('[apps] daily volume snapshot failed; the next pass retries', { volumeId: volume.volumeId, error: String(error) });
    }
  }
  return { purged, snapshotted, untagged, errors };
}
