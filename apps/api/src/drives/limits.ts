// Files storage limits: what one project's Files and all of an account's Files
// may hold, checked here before any byte of a write reaches Platinum.
//
// Every customer's Files live in Kortix's ONE Platinum org. Platinum caps each
// volume (one per project) and the org as a whole, so without a Kortix limit
// one account could fill the org for everyone. The plan decides the figures
// (`TierConfig.driveStorage` in billing/services/tiers.ts); an exception is the
// `driveProjectBytes` / `driveAccountBytes` entitlement override. Platinum's
// own limits stay behind these, and its refusals are mapped in volumes.ts.

import { drives } from '@kortix/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { config } from '../config';
import { resolveAccountBilling } from '../billing/services/billing-cache';
import { getTier } from '../billing/services/tiers';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import {
  type DriveVolume,
  DriveStorageError,
  formatBytes,
  getDriveVolume,
  type PlatinumMountLimits,
  platinumVolumeLimits,
  sandboxMountLimit,
  statVolumeFile,
  type VolumeInfo,
  volumeFolderUsage,
} from './volumes';

const GIB = 1024 ** 3;

/** Platinum's folder-mount cap when its limits cannot be read (its default since #2412). */
export const DEFAULT_FOLDER_MOUNT_BYTES = 10 * GIB;

/** One request body the raw upload takes (`PUT …/files/content`); larger files go up in blocks. */
export const MAX_DRIVE_REQUEST_BYTES = 64 * 1024 * 1024;

/** A folder at or past this share of the folder-mount cap is shown as close to it. */
export const FOLDER_MOUNT_WARN_RATIO = 0.8;

/** The limits a project's Files answer to. `null` = no Kortix limit (billing off); Platinum's still apply. */
export interface DriveLimits {
  /** What this project's Files may hold. Never above Platinum's volume size. */
  projectBytes: number | null;
  /** What all the account's projects' Files may hold together. */
  accountBytes: number | null;
  /** The largest one file: the folder-mount cap, since a larger file makes its folder unmountable. */
  fileBytes: number;
  /** One raw upload request; the SDK sends a larger file in 1 MiB blocks. */
  requestBytes: number;
  /** The largest folder a session mounts (Platinum's `sub_path` cap). */
  folderMountBytes: number;
  /** Folders one session mounts at most (Platinum's per-sandbox mount cap). */
  mountsPerSession: number;
  /** Where the project figure came from: the plan, an override, or Platinum alone. */
  source: 'plan' | 'override' | 'platinum';
}

const positive = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;

function billingEnabled(): boolean {
  return Boolean((config as unknown as { KORTIX_BILLING_INTERNAL_ENABLED?: boolean }).KORTIX_BILLING_INTERNAL_ENABLED);
}

/** The folder-mount cap Platinum publishes, under either name. */
export function folderMountBytesFrom(pt: PlatinumMountLimits): number {
  return positive(pt.sub_path_max_bytes) ?? positive(pt.subdir_max_bytes) ?? DEFAULT_FOLDER_MOUNT_BYTES;
}

/**
 * The limits as one pure step: the plan's figures (or the overrides), clamped
 * to Platinum's. Exported for the unit test; callers use {@link driveLimitsFor}.
 */
export function combineDriveLimits(input: {
  plan: { projectBytes: number; accountBytes: number } | null;
  overrides: { driveProjectBytes?: number; driveAccountBytes?: number };
  platinum: PlatinumMountLimits;
  mountsPerSession: number;
}): DriveLimits {
  const volumeBytes = positive(input.platinum.max_bytes_per_volume);
  const overridden = input.overrides.driveProjectBytes !== undefined;
  let projectBytes = input.overrides.driveProjectBytes ?? input.plan?.projectBytes ?? null;
  const accountBytes = input.overrides.driveAccountBytes ?? input.plan?.accountBytes ?? null;
  if (volumeBytes !== null) projectBytes = projectBytes === null ? volumeBytes : Math.min(projectBytes, volumeBytes);
  const folderMountBytes = folderMountBytesFrom(input.platinum);
  // Not clamped to the project figure: a file larger than what is left gets
  // the storage refusal, which says what is used and what is left.
  const fileBytes = Math.min(folderMountBytes, positive(input.platinum.max_file_bytes) ?? Number.MAX_SAFE_INTEGER);
  return {
    projectBytes,
    accountBytes,
    fileBytes,
    requestBytes: MAX_DRIVE_REQUEST_BYTES,
    folderMountBytes,
    mountsPerSession: input.mountsPerSession,
    source: overridden ? 'override' : input.plan ? 'plan' : 'platinum',
  };
}

/** The limits of an account's Files: its plan (or override), clamped to Platinum's. */
export async function driveLimitsFor(accountId: string): Promise<DriveLimits> {
  const [platinum, mountsPerSession, billing] = await Promise.all([
    platinumVolumeLimits(),
    sandboxMountLimit(),
    resolveAccountBilling(accountId).catch((err) => {
      logger.warn('[drives] reading the plan for the Files limits failed; the free plan applies', {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
  ]);
  // Billing off (local, self-hosted): no plan, so no plan limit. A row that
  // cannot be read reads as Free, like every other limit (account-limits.ts).
  const planKey = !billing || billing.source === 'no_account' ? 'free' : billing.features.key;
  return combineDriveLimits({
    plan: billingEnabled() ? getTier(planKey).driveStorage : null,
    overrides: billing?.limitOverrides ?? {},
    platinum,
    mountsPerSession,
  });
}

// ─── Usage ────────────────────────────────────────────────────────────────

/** A folder Platinum measured for its folder mounts (`GET /v1/volumes/:v` `folders`, #2422). */
interface MeasuredFolder {
  path: string;
  bytes: number;
}

/** What a volume holds, as Platinum last answered. */
interface VolumeUsage {
  usedBytes: number;
  fileCount: number;
  /** Platinum's id of the head commit: folder sizes are cached per head. */
  head: string | null;
  /** The folders Platinum measured (mounted ones); empty on an older Platinum. */
  folders: MeasuredFolder[];
  at: number;
}

// replica-local: a per-API-process read-through cache of Platinum volume sizes; staleness is bounded by USAGE_TTL_MS.
const usageCache = new Map<string, VolumeUsage>();
// replica-local: the one read in flight per volume, shared by concurrent callers (single-flight).
const usageInFlight = new Map<string, Promise<VolumeUsage | null>>();
/** A display may be this old; a write decision always reads fresh. */
const USAGE_TTL_MS = 60_000;
const USAGE_CACHE_MAX = 5_000;

type UsageDrive = { platinumVolumeName: string; platinumVolumeRegion: string | null; platinumVolumeId: string | null };

const volumeOf = (d: UsageDrive): DriveVolume => ({ name: d.platinumVolumeName, region: d.platinumVolumeRegion ?? null });

const empty = (): VolumeUsage => ({ usedBytes: 0, fileCount: 0, head: null, folders: [], at: Date.now() });

function measuredFolders(raw: unknown): MeasuredFolder[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is { path: string; bytes: number } => !!f && typeof f.path === 'string' && Number.isFinite(Number(f.bytes)))
    .map((f) => ({ path: f.path, bytes: Number(f.bytes) }));
}

async function readVolumeUsage(drive: UsageDrive): Promise<VolumeUsage | null> {
  const cached = usageCache.get(drive.platinumVolumeName);
  try {
    const info = (await getDriveVolume(volumeOf(drive), AbortSignal.timeout(5_000))) as VolumeInfo & {
      usage?: { logical_bytes?: number; file_count?: number };
      folders?: unknown;
    };
    const value: VolumeUsage = {
      usedBytes: Number(info.usage?.logical_bytes ?? info.logical_bytes ?? 0),
      fileCount: Number(info.usage?.file_count ?? info.file_count ?? 0),
      head: info.head_commit_id ?? null,
      folders: measuredFolders(info.folders),
      at: Date.now(),
    };
    if (usageCache.size >= USAGE_CACHE_MAX) usageCache.clear();
    usageCache.set(drive.platinumVolumeName, value);
    return value;
  } catch (err) {
    if (err instanceof DriveStorageError && err.code === 'volume_not_found') return empty();
    return cached ?? null;
  }
}

/**
 * What one drive's volume holds: one `GET /v1/volumes/:v`, cached 60 s and
 * shared by concurrent callers. `fresh` skips the cache (a write decision):
 * it still joins a read already in flight. A drive with no volume yet holds
 * nothing; null only when Platinum could not say.
 */
export async function driveVolumeUsage(drive: UsageDrive, opts: { fresh?: boolean } = {}): Promise<VolumeUsage | null> {
  // The volume is addressed by its deterministic name; a row may hold data
  // with no stored id (2026-11-02: 182 of 359 prod drives). A volume that was
  // never opened answers volume_not_found, which reads as empty.
  if (!drive.platinumVolumeName) return empty();
  const cached = usageCache.get(drive.platinumVolumeName);
  if (!opts.fresh && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached;
  const inFlight = usageInFlight.get(drive.platinumVolumeName);
  if (inFlight) return inFlight;
  const read = readVolumeUsage(drive).finally(() => usageInFlight.delete(drive.platinumVolumeName));
  usageInFlight.set(drive.platinumVolumeName, read);
  return read;
}

/**
 * A write, a delete or a restore changed what the drive holds: the next read
 * asks storage again. A committed write is in Platinum's figure at once; an
 * overwrite's growth is unknown here, so it is never guessed.
 */
export function forgetDriveUsage(volumeName: string): void {
  usageCache.delete(volumeName);
}

export interface ProjectStorageUsage {
  projectId: string;
  driveId: string;
  /** Null when Platinum could not say. */
  usedBytes: number | null;
  fileCount: number | null;
}

/**
 * Every project drive of the account and what each holds, 8 reads at a time,
 * each from the 60 s cache. `freshVolume` is read fresh: the drive a write
 * decision is about.
 */
export async function accountDriveUsage(
  accountId: string,
  opts: { freshVolume?: string } = {},
): Promise<{ usedBytes: number; complete: boolean; projects: ProjectStorageUsage[] }> {
  const rows = await db
    .select({
      driveId: drives.driveId,
      projectId: drives.projectId,
      platinumVolumeName: drives.platinumVolumeName,
      platinumVolumeRegion: drives.platinumVolumeRegion,
      platinumVolumeId: drives.platinumVolumeId,
    })
    .from(drives)
    .where(and(eq(drives.accountId, accountId), eq(drives.kind, 'project'), isNotNull(drives.projectId)));
  const projects: ProjectStorageUsage[] = new Array(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, rows.length) }, async () => {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i]!;
        const usage = await driveVolumeUsage(row, { fresh: row.platinumVolumeName === opts.freshVolume });
        projects[i] = { projectId: row.projectId!, driveId: row.driveId, usedBytes: usage?.usedBytes ?? null, fileCount: usage?.fileCount ?? null };
      }
    }),
  );
  return {
    usedBytes: projects.reduce((n, p) => n + (p.usedBytes ?? 0), 0),
    complete: projects.every((p) => p.usedBytes !== null),
    projects,
  };
}

// ─── Folder sizes ─────────────────────────────────────────────────────────

/** What a folder holds, against the folder-mount cap. */
export interface DriveFolderSize {
  path: string;
  bytes: number;
  /** False when storage stopped before the end of the folder: `bytes` is then a floor. */
  complete: boolean;
}

// replica-local: one folder's size per volume head; a commit is immutable, so an entry is right until the head moves.
const folderSizeCache = new Map<string, DriveFolderSize>();
// replica-local: the one folder read in flight per key, shared by concurrent callers.
const folderInFlight = new Map<string, Promise<DriveFolderSize | null>>();
/** Folders sized per request beyond the ones Platinum already measured. */
const FOLDER_LOOKUPS_PER_REQUEST = 16;

/**
 * What each folder holds. A folder sessions mount is in the volume's own
 * `folders` (Platinum measures it at the mount, #2422); any other folder costs
 * one `files/usage?path=`, which Platinum caches per commit, cached here per
 * head and shared by concurrent callers: at most 16 per request. An older
 * Platinum without either answers nothing, never a recursive listing.
 */
export async function driveFolderSizes(drive: UsageDrive, folders: string[]): Promise<Map<string, DriveFolderSize>> {
  const wanted = [...new Set(folders.filter((f) => f && f !== '/'))];
  const out = new Map<string, DriveFolderSize>();
  if (!wanted.length || !drive.platinumVolumeName) return out;
  const usage = await driveVolumeUsage(drive);
  if (!usage) return out;
  const measured = new Map(usage.folders.map((f) => [f.path, f]));
  const missing: string[] = [];
  for (const path of wanted) {
    const m = measured.get(path);
    if (m) out.set(path, { path, bytes: m.bytes, complete: true });
    else missing.push(path);
  }
  if (!usage.head) return out;
  await Promise.all(
    missing.slice(0, FOLDER_LOOKUPS_PER_REQUEST).map(async (path) => {
      const key = `${drive.platinumVolumeName}:${usage.head}:${path}`;
      const hit = folderSizeCache.get(key);
      if (hit) return void out.set(path, hit);
      let read = folderInFlight.get(key);
      if (!read) {
        read = volumeFolderUsage(volumeOf(drive), path)
          .then((u) => {
            if (!u) return null;
            const size = { path, bytes: u.bytes, complete: u.complete };
            if (folderSizeCache.size >= USAGE_CACHE_MAX) folderSizeCache.clear();
            folderSizeCache.set(key, size);
            return size;
          })
          .catch(() => null)
          .finally(() => folderInFlight.delete(key));
        folderInFlight.set(key, read);
      }
      const size = await read;
      if (size) out.set(path, size);
    }),
  );
  return out;
}

// ─── The check ────────────────────────────────────────────────────────────

/** A write refused by a Kortix limit. The routes answer it like any storage refusal. */
export function storageLimitRefusal(input: {
  limit: 'project_bytes' | 'account_bytes';
  max: number;
  used: number;
  requested: number;
}): DriveStorageError {
  const left = Math.max(0, input.max - input.used);
  const scope = input.limit === 'project_bytes' ? "This project's Files" : "Your account's Files, across all its projects,";
  const fix =
    input.limit === 'project_bytes'
      ? 'Delete files you no longer need, or ask an account admin about a plan with more storage.'
      : 'Delete files in any of its projects, or ask an account admin about a plan with more storage.';
  return new DriveStorageError(
    403,
    `${scope} use ${formatBytes(input.used)} of ${formatBytes(input.max)}. This upload needs ${formatBytes(input.requested)}; ${left > 0 ? `${formatBytes(left)} is left` : 'no space is left'}. ${fix}`,
    'storage_limit_exceeded',
    { limit: input.limit, max: input.max, used: input.used, requested: input.requested },
  );
}

/** One file over the file limit. */
export function fileLimitRefusal(max: number, requested: number): DriveStorageError {
  return new DriveStorageError(
    413,
    `This file is ${formatBytes(requested) === formatBytes(max) ? `larger than ${formatBytes(max)}` : formatBytes(requested)}. A file in Files can be at most ${formatBytes(max)}, the largest folder a session can mount.`,
    'file_too_large',
    { limit: 'file_bytes', max, requested },
  );
}

/**
 * The verdict on one write (or one commit of many files): null when it fits,
 * else the refusal. PURE. The sizes count together, because one commit lands
 * them all at once; `credit` is what the write replaces (an overwrite).
 */
export function driveWriteRefusal(input: {
  limits: DriveLimits;
  sizes: number[];
  projectUsed: number;
  /** Null when the account has no limit, or it was not read. */
  accountUsed: number | null;
  credit: number;
}): DriveStorageError | null {
  const { limits, sizes } = input;
  if (sizes.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    return new DriveStorageError(400, 'Every file of an upload names its size: a whole number of bytes.', 'invalid_size');
  }
  const largest = Math.max(0, ...sizes);
  if (largest > limits.fileBytes) return fileLimitRefusal(limits.fileBytes, largest);
  const total = sizes.reduce((n, size) => n + size, 0);
  if (total <= 0) return null;
  if (limits.projectBytes !== null && input.projectUsed + total - input.credit > limits.projectBytes) {
    return storageLimitRefusal({ limit: 'project_bytes', max: limits.projectBytes, used: input.projectUsed, requested: total });
  }
  if (limits.accountBytes !== null && input.accountUsed !== null && input.accountUsed + total - input.credit > limits.accountBytes) {
    return storageLimitRefusal({ limit: 'account_bytes', max: limits.accountBytes, used: input.accountUsed, requested: total });
  }
  return null;
}

/**
 * Refuse a write that does not fit the project's or the account's Files.
 * `sizes` are the files one commit lands (one for a single write);
 * `replaces` answers the bytes they overwrite, asked only when the write
 * would not fit without that credit. The decision reads what the drive
 * holds fresh from storage, never the display cache: two writes in one
 * cache window must not both pass on the same old figure. A size storage
 * cannot read counts as 0: Platinum's own limits still hold.
 */
export async function assertDriveWriteFits(
  drive: UsageDrive & { accountId: string },
  input: { bytes: number; replaces?: () => Promise<number> } | { sizes: number[]; replaces?: () => Promise<number> },
): Promise<void> {
  const sizes = 'sizes' in input ? input.sizes : [input.bytes];
  const limits = await driveLimitsFor(drive.accountId);
  const early = driveWriteRefusal({ limits, sizes, projectUsed: 0, accountUsed: null, credit: 0 });
  if (early) {
    // Larger than the whole limit: no fresh read can change the answer, but
    // the refusal names what the project holds (the display cache is enough).
    if (early.code !== 'storage_limit_exceeded') throw early;
    const held = await driveVolumeUsage(drive).catch(() => null);
    throw driveWriteRefusal({ limits, sizes, projectUsed: held?.usedBytes ?? 0, accountUsed: null, credit: 0 }) ?? early;
  }
  if (limits.projectBytes === null && limits.accountBytes === null) return;
  const project = await driveVolumeUsage(drive, { fresh: true });
  const account = limits.accountBytes === null ? null : await accountDriveUsage(drive.accountId, { freshVolume: drive.platinumVolumeName });
  const verdict = (credit: number) =>
    driveWriteRefusal({ limits, sizes, projectUsed: project?.usedBytes ?? 0, accountUsed: account?.usedBytes ?? null, credit });
  if (!verdict(0)) return;
  const credit = input.replaces ? Math.max(0, await input.replaces().catch(() => 0)) : 0;
  const refusal = credit > 0 ? verdict(credit) : verdict(0);
  if (refusal) throw refusal;
}

/** At most this many files of one write are looked up for the overwrite credit. */
const CREDIT_LOOKUPS = 200;

/**
 * {@link assertDriveWriteFits} for a write of named files: an overwrite gets
 * credit for the files it replaces (looked up only when it would not fit
 * without it, at most 200).
 */
export async function assertDriveFilesFit(
  drive: UsageDrive & { accountId: string },
  files: Array<{ path: string; bytes: number }>,
  opts: { overwrite: boolean },
): Promise<void> {
  await assertDriveWriteFits(drive, {
    sizes: files.map((f) => f.bytes),
    ...(opts.overwrite && drive.platinumVolumeName
      ? {
          replaces: async () => {
            const sizes = await Promise.all(
              files.slice(0, CREDIT_LOOKUPS).map((f) =>
                statVolumeFile(volumeOf(drive), f.path)
                  .then((st) => (st.type === 'file' ? st.size : 0))
                  .catch(() => 0),
              ),
            );
            return sizes.reduce((n, size) => n + size, 0);
          },
        }
      : {}),
  });
}
