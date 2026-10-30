// Move a project's Files to another Platinum region.
//
// A box mounts only volumes of its own region, so a project's sessions run
// where its Files live (platform/services/sandbox-region.ts). Moving the Files
// moves the project's next sessions. Platinum cannot copy a volume across
// regions (a fork stays in its region's object store), and a volume name that
// exists in one region is refused in every other. So a move copies every file
// into a new volume, `<drive volume name>-<region>`, in the target region, and
// then points the drive row at it in one UPDATE. The old volume is not
// touched: it stays, as it was, until the purge deletes it after the
// retention window. No step deletes or changes a file of the old volume.
//
// One drive, in order:
//  1. Refuse a drive a live box mounts. A box that booted on the old volume
//     would keep writing there after the move.
//  2. Fence (`platinum_volume_move` without `finished_at`): storage refuses
//     every write (volumes.ts `drive_moving`), no new box mounts the drive and
//     a hot-attach skips it (service.ts).
//  3. Settle, then detach the mounts of stopped boxes (they committed at the
//     stop) and drop them from those boxes' rows, and wait until Platinum
//     reports the volume holds every write (`/health`). A box that wakes later
//     runs without these folders and says so; its next box mounts the new one.
//     Storage checks the fence when a write is sent (volumes.ts
//     assertDriveWritable), so a caller that read the row before the fence is
//     refused too.
//  4. Copy: every directory and file, with its mode and mtime, in batches of
//     one upload commit each, into a fresh volume opened in drive mode.
//  5. Verify: the same paths, types and sizes, every file's sha256 read back
//     from the new volume, the old volume's head unchanged since the copy
//     began, and no mount on it.
//  6. Swap the row (name, region, volume id, conflict scan head) and finish
//     the move record. Any failure before this lifts the fence, deletes the
//     half-made volume and leaves the drive where it was. A process that dies
//     mid-move leaves the fence up: `abortDriveMove` lifts it.
//
// The commit history stays with the old volume: the new one starts with the
// copy's commits. Version reads by an old commit id (file history, artifact
// activity) find nothing on the new volume.

import { createHash } from 'node:crypto';
import { drives, sessionSandboxes, type DriveVolumeMoveRecord } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { driveVolumeName } from './access';
import { DRIVE_MOUNTS_METADATA_KEY, type DriveRow, driveVolume, getDrive, recordedDriveMounts } from './service';
import { isDriveSyncBox } from './sync';
import {
  type DriveVolume,
  DriveStorageError,
  volumeHealth,
  commitVolumeUpload,
  deleteDriveVolume,
  detachSandboxVolume,
  getDriveVolume,
  listVolumeFilesPage,
  listVolumeMounts,
  openDriveVolume,
  planVolumeUpload,
  putVolumeUploadBlock,
  readVolumeFile,
  statVolumeFile,
  type VolumeEntry,
  type VolumeMount,
} from './volumes';

const BLOCK_BYTES = 1024 * 1024;
const BLOCK_CONCURRENCY = 8;
/** One upload commit carries at most this many files, or about this many bytes. */
const BATCH_FILES = 2_000;
const BATCH_BYTES = 64 * 1024 * 1024;
/** The copy holds one file in memory: a larger one needs a streaming copy, so such a drive does not move. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** A write sent just before the fence lands within this; a later one fails the head check. */
const FENCE_SETTLE_MS = 10_000;
/** Mount states of a guest that is not running. Every other state counts as live: a move never runs under one. */
const STOPPED_MOUNT_STATES = new Set(['parked', 'lost', 'failed']);
/** The move asks Platinum this many times, 3 s apart (~1 min), whether the old volume holds every write. */
const HEALTH_TRIES = 20;

/** The region a drive moves to; null = Platinum's home region. */
export type MoveTarget = string | null;

export function movedVolumeName(driveId: string, to: MoveTarget): string {
  return `${driveVolumeName(driveId)}-${to ?? 'home'}`;
}

export interface DriveMoveReport {
  driveId: string;
  projectId: string | null;
  from: DriveVolume;
  to: DriveVolume;
  /** `moved`, or why not: `skipped` (try again later, nothing changed) or `failed` (fence lifted, nothing changed). */
  outcome: 'moved' | 'planned' | 'skipped' | 'failed';
  reason?: string;
  files: number;
  dirs: number;
  bytes: number;
  /** Mounts of stopped boxes detached (or that a move would detach). */
  detached: number;
  ms: number;
}

interface Tree {
  files: VolumeEntry[];
  dirs: string[];
  bytes: number;
}

const isLostFound = (path: string) => path === '/lost+found' || path.startsWith('/lost+found/');

async function readTree(volume: DriveVolume): Promise<Tree> {
  const files: VolumeEntry[] = [];
  const dirs: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listVolumeFilesPage(volume, '/', { recursive: true, ...(cursor ? { cursor } : {}) });
    for (const e of page.entries) {
      if (isLostFound(e.path)) continue;
      if (e.type === 'file' && e.size > MAX_FILE_BYTES) throw new MoveRefusal(`${e.path} is larger than ${MAX_FILE_BYTES / 2 ** 20} MiB`);
      if (e.type === 'file') files.push(e);
      else if (e.type === 'dir') dirs.push(e.path);
      else throw new MoveRefusal(`it holds a ${e.type} (${e.path}), which the copy cannot carry`);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return { files, dirs, bytes: files.reduce((n, f) => n + Number(f.size ?? 0), 0) };
}

/** A reason a drive does not move now; nothing changed. */
class MoveRefusal extends Error {}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function readAll(volume: DriveVolume, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await readVolumeFile(volume, path);
  return new Uint8Array(await res.arrayBuffer());
}

function liveMounts(mounts: VolumeMount[]): VolumeMount[] {
  return mounts.filter((m) => !STOPPED_MOUNT_STATES.has(m.state));
}

/** Wait until Platinum reports the volume holds every write, or refuse the move. */
async function awaitSaved(volume: DriveVolume): Promise<void> {
  let last: { status: string; reason: string | null } = { status: 'unknown', reason: null };
  for (let attempt = 1; attempt <= HEALTH_TRIES; attempt++) {
    last = await volumeHealth(volume);
    if (last.status === 'ok') return;
    if (attempt < HEALTH_TRIES) await Bun.sleep(3_000);
  }
  throw new MoveRefusal(`the old volume does not hold every write yet (${last.status}: ${last.reason ?? 'no reason given'})`);
}

/** Why this drive cannot move to `to` now, or null. Reads only. */
async function refusalFor(drive: DriveRow, to: MoveTarget): Promise<string | null> {
  if ((drive.platinumVolumeRegion ?? null) === to) return `it already lives in ${to ?? 'the home region'}`;
  const move = drive.platinumVolumeMove;
  if (move && !move.finished_at) return 'another move of it is running or did not finish';
  if (move && !move.purged_at) return 'its previous move is not purged yet';
  const syncBoxes = await db
    .select({ metadata: sessionSandboxes.metadata, provider: sessionSandboxes.provider })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.status, 'active'), sql`${sessionSandboxes.metadata}->'driveMounts' @> ${JSON.stringify([{ driveId: drive.driveId }])}::jsonb`));
  if (syncBoxes.some((b) => isDriveSyncBox(b))) return 'a running session syncs it into a box';
  return null;
}

/** Remove the drive's folders from the row of a box whose mount the move detached. */
async function forgetDetachedMount(driveId: string, externalId: string): Promise<void> {
  {
    const rows = await db
      .select({ sandboxId: sessionSandboxes.sandboxId, metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.externalId, externalId));
    for (const row of rows) {
      const kept = recordedDriveMounts(row.metadata).filter((m) => m.driveId !== driveId);
      await db
        .update(sessionSandboxes)
        .set({
          metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ [DRIVE_MOUNTS_METADATA_KEY]: kept })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
    }
  }
}

/** Copy `tree` from `from` into `to` (empty), one upload commit per batch. Returns each file's sha256. */
async function copyTree(from: DriveVolume, to: DriveVolume, tree: Tree): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const batches: VolumeEntry[][] = [[]];
  let batchBytes = 0;
  for (const f of tree.files) {
    const last = batches[batches.length - 1]!;
    if (last.length && (last.length >= BATCH_FILES || batchBytes + f.size > BATCH_BYTES)) {
      batches.push([]);
      batchBytes = 0;
    }
    batches[batches.length - 1]!.push(f);
    batchBytes += f.size;
  }
  for (const [i, batch] of batches.entries()) {
    const dirs = i === 0 ? tree.dirs : [];
    if (!batch.length && !dirs.length) continue;
    const blocks = new Map<string, Uint8Array<ArrayBuffer>>();
    const planned = [];
    for (const f of batch) {
      const [bytes, stat] = await Promise.all([readAll(from, f.path), statVolumeFile(from, f.path)]);
      if (bytes.byteLength !== f.size) throw new Error(`${f.path}: read ${bytes.byteLength} bytes, listed ${f.size}`);
      hashes.set(f.path, sha256(bytes));
      const shas: string[] = [];
      for (let off = 0; off < bytes.byteLength; off += BLOCK_BYTES) {
        const block = bytes.subarray(off, Math.min(bytes.byteLength, off + BLOCK_BYTES));
        const sha = sha256(block);
        blocks.set(sha, block);
        shas.push(sha);
      }
      planned.push({ path: f.path, size: bytes.byteLength, blocks: shas, mtime: Math.max(0, Math.trunc(f.mtime)), ...(stat.mode !== undefined ? { mode: stat.mode } : {}) });
    }
    const plan = (await planVolumeUpload(to, { files: planned, dirs, overwrite: false })) as { upload_id: string; missing?: string[] };
    const missing = [...new Set(plan.missing ?? [])];
    for (let j = 0; j < missing.length; j += BLOCK_CONCURRENCY) {
      await Promise.all(missing.slice(j, j + BLOCK_CONCURRENCY).map((sha) => putVolumeUploadBlock(to, plan.upload_id, sha, blocks.get(sha)!)));
    }
    await commitVolumeUpload(to, plan.upload_id);
  }
  return hashes;
}

/** The new volume holds exactly `tree`: same paths, types and sizes, and every file's bytes. */
async function verifyCopy(to: DriveVolume, tree: Tree, hashes: Map<string, string>): Promise<void> {
  const copied = await readTree(to);
  const want = new Map([...tree.files.map((f) => [f.path, `file:${f.size}`] as const), ...tree.dirs.map((d) => [d, 'dir'] as const)]);
  const have = new Map([...copied.files.map((f) => [f.path, `file:${f.size}`] as const), ...copied.dirs.map((d) => [d, 'dir'] as const)]);
  for (const [path, kind] of want) {
    if (have.get(path) !== kind) throw new Error(`copy check: ${path} is ${have.get(path) ?? 'missing'}, want ${kind}`);
  }
  for (const path of have.keys()) if (!want.has(path)) throw new Error(`copy check: ${path} is not in the source`);
  for (const f of tree.files) {
    if (sha256(await readAll(to, f.path)) !== hashes.get(f.path)) throw new Error(`copy check: ${f.path} bytes differ`);
  }
}

/** Lift this move's fence, never a finished move's record. True when it was this move's and is lifted now. */
async function liftFence(driveId: string, startedAt: string): Promise<boolean> {
  const lifted = await db
    .update(drives)
    .set({ platinumVolumeMove: null, updatedAt: new Date() })
    .where(and(
      eq(drives.driveId, driveId),
      sql`${drives.platinumVolumeMove}->>'started_at' = ${startedAt}`,
      sql`not (${drives.platinumVolumeMove} ? 'finished_at')`,
    ))
    .returning({ driveId: drives.driveId });
  return lifted.length > 0;
}

/**
 * Plan (`apply: false`, reads only) or run the move of one drive. Never
 * throws for a drive that cannot move now: the report says why.
 */
export async function moveDriveToRegion(driveId: string, to: MoveTarget, opts: { apply: boolean }): Promise<DriveMoveReport> {
  const t0 = Date.now();
  const drive = await getDrive(driveId);
  if (!drive) {
    // Deleted since the run listed it (its project went): nothing to move.
    const none: DriveVolume = { name: '', region: null };
    return { driveId, projectId: null, from: none, to: { name: movedVolumeName(driveId, to), region: to }, outcome: 'skipped', reason: 'the drive no longer exists', files: 0, dirs: 0, bytes: 0, detached: 0, ms: Date.now() - t0 };
  }
  const from = driveVolume(drive);
  const target: DriveVolume = { name: movedVolumeName(drive.driveId, to), region: to, unfenced: true };
  const report: DriveMoveReport = {
    driveId, projectId: drive.projectId, from, to: target, outcome: 'planned', files: 0, dirs: 0, bytes: 0, detached: 0, ms: 0,
  };
  const done = (outcome: DriveMoveReport['outcome'], reason?: string) => ({ ...report, outcome, ...(reason ? { reason } : {}), ms: Date.now() - t0 });

  let tree: Tree = { files: [], dirs: [], bytes: 0 };
  let mounts: VolumeMount[] = [];
  try {
    const refusal = await refusalFor(drive, to);
    if (refusal) return done('skipped', refusal);
    if (drive.platinumVolumeId) {
      mounts = await listVolumeMounts(from);
      if (liveMounts(mounts).length) return done('skipped', `${liveMounts(mounts).length} running box(es) mount it`);
      tree = await readTree(from);
    }
  } catch (err) {
    if (err instanceof MoveRefusal) return done('skipped', `it cannot move: ${err.message}`);
    // Nothing changed yet: report it and let the caller go on with the next drive.
    return done('failed', err instanceof Error ? err.message : String(err));
  }
  Object.assign(report, { files: tree.files.length, dirs: tree.dirs.length, bytes: tree.bytes, detached: mounts.length });
  if (!opts.apply) return done('planned');

  // 2. Fence.
  const startedAt = new Date().toISOString();
  const record: DriveVolumeMoveRecord = { to: to ?? 'home', from_name: from.name, from_region: from.region, started_at: startedAt };
  const fenced = await db
    .update(drives)
    .set({ platinumVolumeMove: record, updatedAt: new Date() })
    .where(and(
      eq(drives.driveId, drive.driveId),
      eq(drives.platinumVolumeName, from.name),
      sql`(${drives.platinumVolumeMove} is null or ${drives.platinumVolumeMove} ? 'purged_at')`,
    ))
    .returning({ driveId: drives.driveId });
  if (!fenced.length) return done('skipped', 'the drive changed while the move was planned');

  let created = false;
  try {
    // 3. Settle, then nothing may mount the old volume.
    await Bun.sleep(FENCE_SETTLE_MS);
    const fresh = await getDrive(drive.driveId);
    if (!fresh?.platinumVolumeId && drive.platinumVolumeId) throw new Error('the drive lost its volume during the move');
    const hasVolume = Boolean(fresh?.platinumVolumeId);
    let fromHead: string | null = null;
    let volumeId: string | null = null;
    if (hasVolume) {
      const now = await listVolumeMounts(from);
      if (liveMounts(now).length) throw new MoveRefusal(`${liveMounts(now).length} running box(es) mount it`);
      report.detached = 0;
      for (const m of now) {
        await detachSandboxVolume(m.sandboxId, m.mountPath);
        await forgetDetachedMount(drive.driveId, m.sandboxId);
        report.detached++;
      }
      await awaitSaved(from);
      fromHead = (await getDriveVolume(from)).head_commit_id ?? null;
      tree = await readTree(from);
      Object.assign(report, { files: tree.files.length, dirs: tree.dirs.length, bytes: tree.bytes });

      // 4. Copy into a fresh volume. One left by an earlier failed try is ours (no row names it): start over.
      const existing = await getDriveVolume(target).catch((err) => {
        if (err instanceof DriveStorageError && err.code === 'volume_not_found') return null;
        throw err;
      });
      if (existing) await deleteDriveVolume(target);
      const opened = await openDriveVolume(target);
      created = true;
      volumeId = opened.id;
      const hashes = await copyTree(from, target, tree);

      // 5. Verify.
      await verifyCopy(target, tree, hashes);
      const head = (await getDriveVolume(from)).head_commit_id ?? null;
      if (head !== fromHead) throw new MoveRefusal('the old volume changed during the copy');
      if ((await listVolumeMounts(from)).length) throw new MoveRefusal('a box mounted the old volume during the copy');
    }
    // A drive with no volume yet moves by its row alone: the first use opens
    // its volume in the new region (under the new name, which no region holds).

    // 6. Swap.
    const finished: DriveVolumeMoveRecord = { ...record, from_head: fromHead, finished_at: new Date().toISOString() };
    const swapped = await db
      .update(drives)
      .set({
        platinumVolumeName: target.name,
        platinumVolumeRegion: to,
        platinumVolumeId: volumeId,
        conflictScanHead: null,
        platinumVolumeMove: finished,
        updatedAt: new Date(),
      })
      .where(and(eq(drives.driveId, drive.driveId), eq(drives.platinumVolumeName, from.name), sql`${drives.platinumVolumeMove}->>'started_at' = ${startedAt}`))
      .returning({ driveId: drives.driveId });
    if (!swapped.length) throw new Error('the drive row changed during the move');
    logger.info(`[drives] moved drive ${drive.driveId} from ${from.region ?? 'home'} to ${to ?? 'home'}`, {
      files: report.files, bytes: report.bytes, detached: report.detached, ms: Date.now() - t0,
    });
    return done('moved');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const lifted = await liftFence(drive.driveId, startedAt).catch((e) => {
      logger.error(`[drives] lifting the move fence of drive ${drive.driveId} failed:`, { error: e instanceof Error ? e.message : String(e) });
      return false;
    });
    if (!lifted) {
      // The swap may have landed though its answer did not: the row says.
      const now = await getDrive(drive.driveId).catch(() => null);
      if (now?.platinumVolumeName === target.name && now.platinumVolumeMove?.finished_at) return done('moved');
      logger.error(`[drives] moving drive ${drive.driveId} failed and its fence is still up; run the abort command`, { error: reason });
      return done('failed', `${reason}; the fence is still up: run the abort command for this drive`);
    }
    // The fence is down and the row names the old volume: the half-made one is nobody's.
    if (created) await deleteDriveVolume(target).catch(() => undefined);
    if (err instanceof MoveRefusal) return done('skipped', reason);
    logger.warn(`[drives] moving drive ${drive.driveId} failed; it stays where it was:`, { error: reason });
    return done('failed', reason);
  }
}

/**
 * Lift the fence of a move that will not finish (its process died): the drive
 * stays where it was, and the half-made target volume, which no row names, is
 * deleted. Refuses a move that finished.
 */
export async function abortDriveMove(driveId: string): Promise<string> {
  const drive = await getDrive(driveId);
  const move = drive?.platinumVolumeMove;
  if (!drive || !move) return 'no move to abort';
  if (move.finished_at) return 'the move finished; nothing to abort';
  const to: MoveTarget = move.to === 'home' ? null : move.to;
  const target: DriveVolume = { name: movedVolumeName(drive.driveId, to), region: to, unfenced: true };
  if (!(await liftFence(drive.driveId, move.started_at))) return 'the move record changed; nothing done';
  if (drive.platinumVolumeName !== target.name) await deleteDriveVolume(target);
  logger.info(`[drives] aborted the move of drive ${drive.driveId} to ${move.to}`);
  return `fence lifted; the drive stays in ${drive.platinumVolumeRegion ?? 'home'}`;
}

export interface PurgeReport {
  driveId: string;
  volume: DriveVolume;
  outcome: 'purged' | 'kept' | 'planned';
  reason?: string;
}

/**
 * Delete the old volume of every move that finished more than `olderThanMs`
 * ago. An old volume that changed after the copy (a write the fence missed),
 * or that a box still mounts, is kept and reported: its files need a person.
 */
export async function purgeMovedVolumes(opts: { olderThanMs: number; apply: boolean }): Promise<PurgeReport[]> {
  const rows = await db
    .select()
    .from(drives)
    .where(sql`${drives.platinumVolumeMove} ? 'finished_at' and not (${drives.platinumVolumeMove} ? 'purged_at')`);
  const out: PurgeReport[] = [];
  for (const row of rows) {
    const move = row.platinumVolumeMove!;
    const volume: DriveVolume = { name: move.from_name, region: move.from_region, unfenced: true };
    if (Date.now() - Date.parse(move.finished_at!) < opts.olderThanMs) {
      out.push({ driveId: row.driveId, volume, outcome: 'kept', reason: 'inside the retention window' });
      continue;
    }
    const info = await getDriveVolume(volume).catch((err) => {
      if (err instanceof DriveStorageError && err.code === 'volume_not_found') return null;
      throw err;
    });
    if (info && (info.head_commit_id ?? null) !== (move.from_head ?? null)) {
      out.push({ driveId: row.driveId, volume, outcome: 'kept', reason: 'it changed after the move; compare it with the new volume by hand' });
      continue;
    }
    if (info && (await listVolumeMounts(volume)).length) {
      out.push({ driveId: row.driveId, volume, outcome: 'kept', reason: 'a box still mounts it' });
      continue;
    }
    if (info) {
      const health = await volumeHealth(volume);
      if (health.status !== 'ok') {
        out.push({ driveId: row.driveId, volume, outcome: 'kept', reason: `storage does not report it saved (${health.status})` });
        continue;
      }
    }
    if (!opts.apply) {
      out.push({ driveId: row.driveId, volume, outcome: 'planned' });
      continue;
    }
    if (info) await deleteDriveVolume(volume);
    await db
      .update(drives)
      .set({ platinumVolumeMove: { ...move, purged_at: new Date().toISOString() }, updatedAt: new Date() })
      .where(eq(drives.driveId, row.driveId));
    out.push({ driveId: row.driveId, volume, outcome: 'purged' });
  }
  return out;
}
