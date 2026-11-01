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
  listVolumeFilesPage,
  type PlatinumMountLimits,
  platinumVolumeLimits,
  sandboxMountLimit,
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

/** What a volume holds, as Platinum last answered. */
interface VolumeUsage {
  usedBytes: number;
  fileCount: number;
  /** Platinum's id of the head commit: the folder sizes below are cached per head. */
  head: string | null;
  at: number;
}

// replica-local: a per-API-process read-through cache of Platinum volume sizes; staleness is bounded by USAGE_TTL_MS.
const usageCache = new Map<string, VolumeUsage>();
const USAGE_TTL_MS = 30_000;
const USAGE_CACHE_MAX = 5_000;

type UsageDrive = { platinumVolumeName: string; platinumVolumeRegion: string | null; platinumVolumeId: string | null };

const volumeOf = (d: UsageDrive): DriveVolume => ({ name: d.platinumVolumeName, region: d.platinumVolumeRegion ?? null });

/**
 * What one drive's volume holds, cached 30 s. Null when the drive has no
 * volume yet (it holds nothing) is reported as 0; null only when Platinum
 * could not say.
 */
export async function driveVolumeUsage(drive: UsageDrive, opts: { fresh?: boolean } = {}): Promise<VolumeUsage | null> {
  if (!drive.platinumVolumeId) return { usedBytes: 0, fileCount: 0, head: null, at: Date.now() };
  const cached = usageCache.get(drive.platinumVolumeName);
  if (!opts.fresh && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached;
  try {
    const info = await getDriveVolume(volumeOf(drive), AbortSignal.timeout(5_000));
    const value: VolumeUsage = {
      usedBytes: Number(info.logical_bytes ?? 0),
      fileCount: Number(info.file_count ?? 0),
      head: info.head_commit_id ?? null,
      at: Date.now(),
    };
    if (usageCache.size >= USAGE_CACHE_MAX) usageCache.clear();
    usageCache.set(drive.platinumVolumeName, value);
    return value;
  } catch (err) {
    if (err instanceof DriveStorageError && err.code === 'volume_not_found') return { usedBytes: 0, fileCount: 0, head: null, at: Date.now() };
    return cached ?? null;
  }
}

/**
 * A write, a delete or a restore changed what the drive holds: the next check
 * reads it from storage again. A committed write is in Platinum's figure at
 * once; an overwrite's growth is unknown here, so it is never guessed.
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

/** Every project drive of the account and what each holds. Drives are read 8 at a time. */
export async function accountDriveUsage(accountId: string): Promise<{ usedBytes: number; complete: boolean; projects: ProjectStorageUsage[] }> {
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
        const usage = await driveVolumeUsage(row);
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
  files: number;
  /** False when the listing stopped before the end: `bytes` is then a floor. */
  complete: boolean;
}

// replica-local: folder sizes per volume head; a commit is immutable, so an entry is right until the head moves.
const folderSizeCache = new Map<string, { head: string; sizes: Map<string, DriveFolderSize> }>();
/** The listing reads at most this many pages of 5,000 entries (200,000 entries). */
const FOLDER_SIZE_MAX_PAGES = 40;

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * What each folder holds, from one recursive listing of the volume, cached
 * per head commit. Platinum's own `files/usage` (#2422) sums a folder the
 * same way a mount does; the listing works on every Platinum and needs no
 * call per folder.
 */
export async function driveFolderSizes(drive: UsageDrive, folders: string[]): Promise<Map<string, DriveFolderSize>> {
  const wanted = [...new Set(folders.filter((f) => f && f !== '/'))];
  const out = new Map<string, DriveFolderSize>();
  if (!wanted.length || !drive.platinumVolumeId) return out;
  const usage = await driveVolumeUsage(drive);
  const head = usage?.head ?? null;
  const cached = head ? folderSizeCache.get(drive.platinumVolumeName) : undefined;
  if (cached && cached.head === head && wanted.every((f) => cached.sizes.has(f))) {
    for (const f of wanted) out.set(f, cached.sizes.get(f)!);
    return out;
  }
  for (const f of wanted) out.set(f, { path: f, bytes: 0, files: 0, complete: true });
  let cursor: string | undefined;
  let pages = 0;
  let complete = true;
  try {
    do {
      const page = await listVolumeFilesPage(volumeOf(drive), '/', { recursive: true, cursor, signal: AbortSignal.timeout(15_000) });
      for (const e of page.entries) {
        if (e.type !== 'file') continue;
        for (const f of wanted) {
          if (!within(e.path, f)) continue;
          const size = out.get(f)!;
          size.bytes += Number(e.size ?? 0);
          size.files += 1;
        }
      }
      cursor = page.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < FOLDER_SIZE_MAX_PAGES);
    if (cursor) complete = false;
  } catch (err) {
    logger.warn('[drives] measuring folder sizes failed', { volume: drive.platinumVolumeName, error: err instanceof Error ? err.message : String(err) });
    return new Map();
  }
  if (!complete) for (const size of out.values()) size.complete = false;
  if (head && complete) {
    if (folderSizeCache.size >= USAGE_CACHE_MAX) folderSizeCache.clear();
    folderSizeCache.set(drive.platinumVolumeName, { head, sizes: new Map(out) });
  }
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
 * Refuse a write that does not fit the project's or the account's Files.
 * `bytes` is what the write adds; `replaces` answers the size of the file it
 * overwrites (asked only when the write would not fit without that credit).
 * A size Platinum cannot read counts as 0: Platinum's own limits still hold.
 */
export async function assertDriveWriteFits(
  drive: UsageDrive & { accountId: string },
  input: { bytes: number; replaces?: () => Promise<number> },
): Promise<void> {
  const limits = await driveLimitsFor(drive.accountId);
  if (input.bytes > limits.fileBytes) throw fileLimitRefusal(limits.fileBytes, input.bytes);
  if (input.bytes <= 0 || (limits.projectBytes === null && limits.accountBytes === null)) return;
  const project = await driveVolumeUsage(drive);
  const used = project?.usedBytes ?? 0;
  let credit: number | null = null;
  const replaced = async () => {
    credit ??= input.replaces ? Math.max(0, await input.replaces().catch(() => 0)) : 0;
    return credit;
  };
  if (limits.projectBytes !== null && used + input.bytes > limits.projectBytes) {
    if (used + input.bytes - (await replaced()) > limits.projectBytes) {
      throw storageLimitRefusal({ limit: 'project_bytes', max: limits.projectBytes, used, requested: input.bytes });
    }
  }
  if (limits.accountBytes === null) return;
  const account = await accountDriveUsage(drive.accountId);
  if (account.usedBytes + input.bytes > limits.accountBytes) {
    if (account.usedBytes + input.bytes - (await replaced()) > limits.accountBytes) {
      throw storageLimitRefusal({ limit: 'account_bytes', max: limits.accountBytes, used: account.usedBytes, requested: input.bytes });
    }
  }
}
