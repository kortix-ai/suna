// The storage behind a drive: one Platinum volume in drive sync mode. Every
// call here speaks the Platinum volumes API; nothing above this file does.

import { createHash } from 'node:crypto';
import { drives } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { isPlatinumConfigured, platinumFetch, platinumRegionControlPlane } from '../shared/platinum';
import { DEFAULT_SANDBOX_MOUNT_LIMIT } from './access';
import { parseVolumeWriteCommit, type VolumeWriteCommit } from './volume-commit';

export { parseVolumeWriteCommit, type VolumeWriteCommit } from './volume-commit';

/** A storage failure the drive routes turn into a response. `message` is user-facing. */
export class DriveStorageError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 503,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DriveStorageError';
  }
}

export function driveStorageAvailable(): boolean {
  return isPlatinumConfigured();
}

const FILE_TIMEOUT_MS = 5 * 60_000;

export const FILE_CHANGED_MESSAGE = 'This file changed since you opened it. Reload it to see the latest version, then save again.';

export const DRIVE_MOVING_MESSAGE = 'These files are moving to another region. Try again in a minute.';

/**
 * A drive's volume as every storage call addresses it. Platinum volumes
 * belong to the control plane that created them: the global origin answers
 * `409 volume_in_other_region` for a volume of another region, for reads and
 * opens alike. So every call goes to the volume's own region.
 */
export interface DriveVolume {
  name: string;
  /** The Platinum region it lives in; null = the home region (PLATINUM_API_URL). */
  region: string | null;
  /** A region move is copying it (drives/region-move.ts): every write is refused. */
  moving?: boolean;
  /**
   * An operator's volume outside a drive row's life: a move's target, the
   * purge, the deletion queue. Its writes skip the write fence.
   */
  unfenced?: true;
}

/**
 * The write fence, checked when a write is sent, not when the caller read the
 * drive row: a write that read the row before a region move fenced it, or
 * before the move pointed the row at its new volume, is refused here instead
 * of landing in the volume the move copies from. Only a row that still names
 * this volume, with no move running, may write it. One indexed read per write.
 */
export async function assertDriveWritable(volume: DriveVolume): Promise<void> {
  if (volume.unfenced) return;
  if (!volume.moving) {
    const [row] = await db
      .select({ move: drives.platinumVolumeMove })
      .from(drives)
      .where(eq(drives.platinumVolumeName, volume.name))
      .limit(1);
    if (row && !(row.move && !row.move.finished_at)) return;
  }
  throw new DriveStorageError(503, DRIVE_MOVING_MESSAGE, 'drive_moving');
}

/** The control plane that owns the volume: its region's own, or the global origin for home. */
function volumeOrigin(volume: DriveVolume): string | undefined {
  if (!volume.region) return undefined;
  const origin = platinumRegionControlPlane(volume.region);
  if (!origin) {
    logger.warn(`[drives] no Platinum control plane is known for region ${volume.region}`);
    throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
  }
  return origin;
}

/**
 * One Platinum call. `volume` names the drive volume the call is about (its
 * region's control plane gets it); null is a call about a sandbox or the
 * account, which shared/platinum.ts routes by sandbox id.
 */
async function call(volume: DriveVolume | null, path: string, init: RequestInit = {}, allowRangeRefusal = false): Promise<Response> {
  if (!driveStorageAvailable()) throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
  const method = (init.method ?? 'GET').toUpperCase();
  // An upload's blocks change nothing until its commit, which is checked.
  if (volume && method !== 'GET' && !/\/files\/upload\/[^/]+\/blocks\//.test(path)) await assertDriveWritable(volume);
  const origin = volume ? volumeOrigin(volume) : undefined;
  let res: Response;
  try {
    res = await platinumFetch(path, init, origin);
    // Reads are safe to replay while storage recovers; writes may have committed.
    for (const delay of [2_000, 3_000]) {
      if (method !== 'GET' || res.status !== 503 || init.signal?.aborted) break;
      await res.body?.cancel();
      await Bun.sleep(delay);
      init.signal?.throwIfAborted();
      res = await platinumFetch(path, init, origin);
    }
  } catch (err) {
    logger.warn(`[drives] ${init.method ?? 'GET'} ${path} failed:`, { error: err instanceof Error ? err.message : String(err) });
    throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', 'drive_storage_unavailable');
  }
  if (res.ok || (allowRangeRefusal && res.status === 416)) return res;
  const text = await res.text().catch(() => '');
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  switch (res.status) {
    case 400:
      throw new DriveStorageError(400, 'Invalid path', code);
    case 404:
      throw new DriveStorageError(404, code === 'volume_not_found' ? 'Drive not found' : 'File or folder not found', code);
    case 403:
      if (code === 'quota_exceeded') {
        throw new DriveStorageError(409, 'This workspace has reached its drive storage limit. Delete a drive you no longer need, or ask Kortix for more.', code);
      }
      logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> 403 ${text.slice(0, 300)}`);
      throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', code);
    case 409:
      if (code === 'volume_busy') throw new DriveStorageError(409, 'The drive is attached to a running session', code);
      if (code === 'volume_in_other_region') {
        logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> 409 ${text.slice(0, 300)}`);
        throw new DriveStorageError(409, 'These files live in another region than this session', code);
      }
      throw new DriveStorageError(409, 'A file or folder with that name already exists', code);
    case 412:
      throw new DriveStorageError(409, FILE_CHANGED_MESSAGE, 'file_changed');
    case 413:
      throw new DriveStorageError(413, 'File is too large', code);
    case 422:
      if (code === 'sub_path_too_large') throw new DriveStorageError(413, 'This folder is too large to mount in a session', code);
      logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> 422 ${text.slice(0, 300)}`);
      throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', code);
    default:
      logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', code);
  }
}

async function callJson<T>(volume: DriveVolume | null, path: string, init: RequestInit = {}): Promise<T> {
  const res = await call(volume, path, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const v = (volume: DriveVolume) => `/v1/volumes/${encodeURIComponent(volume.name)}`;

export interface VolumeInfo {
  id: string;
  logical_bytes: number;
  file_count: number;
  last_commit_at: string | null;
  head_commit_id?: string | null;
  size_limit_bytes?: number | null;
}

/** The volume does not exist on this storage account (never opened here, or deleted). */
export function isMissingVolume(err: unknown): boolean {
  return err instanceof DriveStorageError && err.code === 'volume_not_found';
}

/**
 * Open-or-create by name in the volume's region, so a retry after a lost
 * response never makes a second volume.
 */
export async function openDriveVolume(volume: DriveVolume, signal?: AbortSignal): Promise<VolumeInfo> {
  try {
    const info = await callJson<VolumeInfo & { region?: string }>(volume, v(volume), {
      method: 'PUT',
      body: JSON.stringify({ sync_mode: 'drive' }),
      ...(signal ? { signal } : {}),
    });
    if (volume.region && info.region && info.region !== volume.region) {
      logger.warn(`[drives] volume ${volume.name} answered from ${info.region}, not ${volume.region}`);
      throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
    }
    return info;
  } catch (err) {
    // A 404 here means volumes are not enabled for the storage account: not a
    // missing file, and not the caller's to fix.
    if (err instanceof DriveStorageError && (err.status === 404 || err.status === 400)) {
      throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
    }
    throw err;
  }
}

export async function getDriveVolume(volume: DriveVolume, signal?: AbortSignal): Promise<VolumeInfo> {
  return callJson<VolumeInfo>(volume, v(volume), signal ? { signal } : {});
}

export async function deleteDriveVolume(volume: DriveVolume): Promise<void> {
  await call(volume, `${v(volume)}?missing_ok=true`, { method: 'DELETE' });
}

export interface VolumeEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
}

export async function listVolumeFiles(
  volume: DriveVolume,
  path: string,
  recursive: boolean,
  signal?: AbortSignal,
  at?: string,
): Promise<VolumeEntry[]> {
  const q = new URLSearchParams({ path, recursive: String(recursive), limit: '10000', ...(at ? { at } : {}) });
  const r = await callJson<{ entries: VolumeEntry[] }>(volume, `${v(volume)}/files?${q}`, signal ? { signal } : {});
  return r.entries ?? [];
}

/** A file's bytes; `at` reads it as it was at that commit. */
export async function readVolumeFile(volume: DriveVolume, path: string, range?: string, at?: string): Promise<Response> {
  const q = new URLSearchParams({ path, ...(at ? { at } : {}) });
  return call(volume, `${v(volume)}/files/content?${q}`, {
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    headers: range ? { Range: range } : {},
  }, true);
}

export async function writeVolumeFile(
  volume: DriveVolume,
  path: string,
  body: Uint8Array<ArrayBuffer>,
  opts: { overwrite: boolean; ifMatch?: string },
): Promise<{ path: string; size: number; version?: string; commit?: VolumeWriteCommit }> {
  const q = new URLSearchParams({ path, overwrite: String(opts.overwrite) });
  const r = await callJson<{ path: string; size: number; version?: string }>(volume, `${v(volume)}/files/content?${q}`, {
    method: 'PUT',
    body,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    // Storage lands the write only while the file is at this version, in the
    // same step as the write: two saves from one version cannot both land.
    headers: { 'Content-Type': 'application/octet-stream', ...(opts.ifMatch ? { 'If-Match': opts.ifMatch } : {}) },
  });
  const commit = parseVolumeWriteCommit(r);
  return { path: r.path ?? path, size: Number(r.size ?? body.byteLength), ...(r.version ? { version: String(r.version) } : {}), ...(commit ? { commit } : {}) };
}

/** One page of a listing, for callers that walk a whole drive (drive sync). */
export async function listVolumeFilesPage(
  volume: DriveVolume,
  path: string,
  opts: { recursive: boolean; cursor?: string; signal?: AbortSignal },
): Promise<{ entries: VolumeEntry[]; next_cursor: string | null }> {
  const q = new URLSearchParams({ path, recursive: String(opts.recursive), limit: '5000' });
  if (opts.cursor) q.set('cursor', opts.cursor);
  const r = await callJson<{ entries: VolumeEntry[]; next_cursor?: string | null }>(volume, `${v(volume)}/files?${q}`,
    opts.signal ? { signal: opts.signal } : {},
  );
  return { entries: r.entries ?? [], next_cursor: r.next_cursor ?? null };
}

export interface VolumeFileStat extends VolumeEntry {
  version: string | null;
  /** The file's permission bits, when storage reports them. */
  mode?: number;
}

/** A file's metadata; `at` stats it as it was at that commit. */
export async function statVolumeFile(volume: DriveVolume, path: string, at?: string): Promise<VolumeFileStat> {
  const q = new URLSearchParams({ path, ...(at ? { at } : {}) });
  const r = await callJson<VolumeFileStat>(volume, `${v(volume)}/files/stat?${q}`, { signal: AbortSignal.timeout(30_000) });
  return {
    path: r.path,
    type: r.type,
    size: Number(r.size ?? 0),
    mtime: Number(r.mtime ?? 0),
    version: r.version ?? null,
    ...(Number.isInteger(r.mode) ? { mode: Number(r.mode) } : {}),
  };
}

/**
 * The block upload protocol, for files too large for one PUT: plan (the
 * store answers which 1 MiB blocks it lacks), send only those, commit.
 */
export async function planVolumeUpload(volume: DriveVolume, plan: unknown): Promise<unknown> {
  return callJson<unknown>(volume, `${v(volume)}/files/upload`, {
    method: 'POST',
    body: JSON.stringify(plan),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

export async function putVolumeUploadBlock(volume: DriveVolume, uploadId: string, sha: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  await call(volume, `${v(volume)}/files/upload/${encodeURIComponent(uploadId)}/blocks/${encodeURIComponent(sha)}`, {
    method: 'PUT',
    body,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

export async function commitVolumeUpload(volume: DriveVolume, uploadId: string): Promise<unknown> {
  return callJson<unknown>(volume, `${v(volume)}/files/upload/${encodeURIComponent(uploadId)}/commit`, {
    method: 'POST',
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

const BLOCK_BYTES = 1024 * 1024;
const BLOCK_CONCURRENCY = 8;

/**
 * Write many files as ONE commit, through the block protocol: the store
 * answers which 1 MiB blocks it lacks, only those travel (8 at a time), and the
 * commit lands every file at once. A reader never sees half a folder.
 */
export async function writeVolumeFiles(
  volume: DriveVolume,
  files: Array<{ path: string; bytes: Uint8Array<ArrayBuffer> }>,
  opts: { overwrite: boolean },
): Promise<VolumeWriteCommit | undefined> {
  if (!files.length) return;
  const blocks = new Map<string, Uint8Array<ArrayBuffer>>();
  const planned = files.map((f) => {
    const shas: string[] = [];
    for (let off = 0; off < f.bytes.byteLength; off += BLOCK_BYTES) {
      const block = f.bytes.subarray(off, Math.min(f.bytes.byteLength, off + BLOCK_BYTES));
      const sha = createHash('sha256').update(block).digest('hex');
      blocks.set(sha, block);
      shas.push(sha);
    }
    return { path: f.path, size: f.bytes.byteLength, blocks: shas };
  });
  const plan = (await planVolumeUpload(volume, { files: planned, overwrite: opts.overwrite })) as { upload_id: string; missing?: string[] };
  const missing = [...new Set(plan.missing ?? [])];
  for (let i = 0; i < missing.length; i += BLOCK_CONCURRENCY) {
    await Promise.all(missing.slice(i, i + BLOCK_CONCURRENCY).map((sha) => putVolumeUploadBlock(volume, plan.upload_id, sha, blocks.get(sha)!)));
  }
  return parseVolumeWriteCommit(await commitVolumeUpload(volume, plan.upload_id));
}

export async function moveVolumeFile(volume: DriveVolume, src: string, dst: string): Promise<void> {
  await call(volume, `${v(volume)}/files/move`, {
    method: 'POST',
    body: JSON.stringify({ src, dst, overwrite: false }),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

export async function removeVolumeFile(volume: DriveVolume, path: string, recursive: boolean): Promise<void> {
  const q = new URLSearchParams({ path, recursive: String(recursive) });
  await call(volume, `${v(volume)}/files?${q}`, { method: 'DELETE', signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
}

export interface VolumeCommit {
  id: string;
  kind: string;
  author: { kind: string; id: string | null };
  created_at: string;
  on_head?: boolean;
  parent_id?: string | null;
  base_id?: string | null;
  merged_from?: string[];
  stats?: { changed_paths?: number; deleted_paths?: number };
}

export async function listVolumeCommits(volume: DriveVolume, limit = 100, opts: { includeSide?: boolean; before?: string } = {}): Promise<VolumeCommit[]> {
  const query = new URLSearchParams({ limit: String(limit), ...(opts.includeSide ? { include_side: 'true' } : {}), ...(opts.before ? { before: opts.before } : {}) });
  const r = await callJson<{ commits: VolumeCommit[] }>(volume, `${v(volume)}/commits?${query}`);
  return r.commits ?? [];
}

export async function getVolumeCommit(volume: DriveVolume, commitId: string): Promise<VolumeCommit> {
  return callJson<VolumeCommit>(volume, `${v(volume)}/commits/${encodeURIComponent(commitId)}`);
}

/**
 * Platinum's verdict on whether the volume holds everything written to it:
 * `ok` once no mount, merge queue, open commit or block not yet in object
 * storage holds a write. `probe=false` reads it from Platinum's database.
 */
export async function volumeHealth(volume: DriveVolume): Promise<{ status: string; reason: string | null }> {
  const r = await callJson<{ status?: string; reason?: string | null }>(volume, `${v(volume)}/health?probe=false`, { signal: AbortSignal.timeout(15_000) });
  return { status: r.status ?? 'unknown', reason: r.reason ?? null };
}

/** One mount of a volume on a sandbox, running or stopped. */
export interface VolumeMount {
  sandboxId: string;
  mountPath: string;
  /** Platinum's mount state: `mounted`/`pulling`/`pending`/`unmounting`/`unflushed` on a live guest, `parked` on a stopped one. */
  state: string;
}

/** Every mount of the volume that has not ended, on any sandbox (`GET /v1/volumes/:v/mounts`). */
export async function listVolumeMounts(volume: DriveVolume): Promise<VolumeMount[]> {
  const r = await callJson<{ mounts?: Array<Record<string, unknown>> }>(volume, `${v(volume)}/mounts`, { signal: AbortSignal.timeout(15_000) });
  return (r.mounts ?? []).map((m) => ({
    sandboxId: String(m.sandbox_id ?? ''),
    mountPath: String(m.mount_path ?? ''),
    state: String(m.state ?? ''),
  }));
}

export async function restoreVolume(volume: DriveVolume, to: string): Promise<void> {
  await call(volume, `${v(volume)}/restore`, { method: 'POST', body: JSON.stringify({ to }) });
}

let mountLimitCache: { value: number; at: number } | null = null;
const MOUNT_LIMIT_TTL_MS = 10 * 60_000;

/** Platinum's `GET /v1/volumes/limits`, the fields the mount plan reads. */
export interface PlatinumMountLimits {
  /** Private mounts per sandbox: each is a disk in the VM. */
  max_mounts_per_sandbox?: number;
  /** Mounts of any share per sandbox. Absent from a Platinum older than node-share counting. */
  max_total_mounts_per_sandbox?: number;
  /** Node share is on for this org: share "node" mounts take no disk. */
  node_share?: boolean;
}

/**
 * How many folders one sandbox mounts. Every drive mount asks for share
 * "node"; with node share on they take no disk, so the plan uses the total
 * cap, else the private one. {@link DEFAULT_SANDBOX_MOUNT_LIMIT} when unknown.
 */
export function mountSlotsFrom(limits: PlatinumMountLimits): number {
  const pick = limits.node_share ? limits.max_total_mounts_per_sandbox : limits.max_mounts_per_sandbox;
  const max = Number(pick ?? limits.max_mounts_per_sandbox);
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_SANDBOX_MOUNT_LIMIT;
}

/** {@link mountSlotsFrom} Platinum's live limits. Cached; the default when they cannot be read. */
export async function sandboxMountLimit(): Promise<number> {
  if (mountLimitCache && Date.now() - mountLimitCache.at < MOUNT_LIMIT_TTL_MS) return mountLimitCache.value;
  let value = DEFAULT_SANDBOX_MOUNT_LIMIT;
  try {
    value = mountSlotsFrom(await callJson<PlatinumMountLimits>(null, '/v1/volumes/limits', { signal: AbortSignal.timeout(5_000) }));
  } catch (err) {
    logger.warn('[drives] reading the sandbox mount limit failed:', { error: err instanceof Error ? err.message : String(err) });
    return value;
  }
  mountLimitCache = { value, at: Date.now() };
  return value;
}

/** One volume mount Platinum holds for a sandbox. */
export interface SandboxVolumeMount {
  mountPath: string;
  /** The volume's name (what a drive attaches by), or its id when Platinum gave no name. */
  volume: string;
  readOnly: boolean;
  /** The folder of the volume mounted, `/` for all of it. */
  subdir: string;
}

/** The volume mounts a sandbox has now, or null when Platinum cannot say. */
export async function sandboxVolumeMounts(externalId: string): Promise<SandboxVolumeMount[] | null> {
  try {
    const body = await callJson<{ volume_mounts?: Array<Record<string, unknown>> | Record<string, unknown> }>(
      null,
      `/v1/sandboxes/${encodeURIComponent(externalId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const mounts = body.volume_mounts;
    if (!mounts) return [];
    if (!Array.isArray(mounts)) {
      return Object.keys(mounts).map((mountPath) => ({ mountPath, volume: '', readOnly: false, subdir: '/' }));
    }
    return mounts.map((m) => ({
      mountPath: String(m.mount_path ?? m.path ?? ''),
      volume: String(m.volume_name ?? m.volume_id ?? ''),
      readOnly: m.read_only === true,
      subdir: typeof m.subdir === 'string' && m.subdir ? m.subdir : '/',
    }));
  } catch {
    return null;
  }
}

/** The volume mounts a sandbox has now, by mount path, or null when Platinum cannot say. */
export async function sandboxMountPaths(externalId: string): Promise<string[] | null> {
  const mounts = await sandboxVolumeMounts(externalId);
  return mounts && mounts.map((m) => m.mountPath);
}

const sandboxMount = (externalId: string, mountPath: string) =>
  `/v1/sandboxes/${encodeURIComponent(externalId)}/volumes/${encodeURIComponent(mountPath)}`;

/**
 * Hot-attach a volume to a running sandbox. Platinum answers 201 once the
 * guest mounted it, 202 while the mount is still pending (it lands within
 * seconds); both count as attached. A sandbox mounts only a volume of its own
 * region: another region's answers `volume_in_other_region`.
 */
export async function attachSandboxVolume(
  externalId: string,
  mountPath: string,
  input: { volume: DriveVolume; readOnly: boolean; subdir?: string },
): Promise<void> {
  // A box writes through its mount: the same fence as any write.
  await assertDriveWritable(input.volume);
  try {
    await call(null, sandboxMount(externalId, mountPath), {
      method: 'POST',
      body: JSON.stringify({
        volume: input.volume.name,
        read_only: input.readOnly,
        ...(input.subdir ? { subdir: input.subdir } : {}),
        share: 'node',
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    if (!(err instanceof DriveStorageError)) throw err;
    if (err.code === 'quota_exceeded') {
      throw new DriveStorageError(
        409,
        'This session already mounts as many drives as a session can. Take a drive out of it first.',
        'drive_mount_limit',
      );
    }
    if (err.code === 'sandbox_not_running') {
      throw new DriveStorageError(409, 'The session is not running; the drive mounts when it starts', err.code);
    }
    if (err.code === 'path_exists') {
      throw new DriveStorageError(409, 'Another drive is already mounted at that path', err.code);
    }
    if (err.code === 'template_lacks_volume_support') {
      throw new DriveStorageError(409, 'This session’s sandbox image cannot mount drives', err.code);
    }
    throw err;
  }
}

/**
 * Detach one mount from a running (or stopped) sandbox, committing its last
 * changes first. A mount that is already gone counts as detached.
 */
export async function detachSandboxVolume(externalId: string, mountPath: string): Promise<void> {
  try {
    await call(null, sandboxMount(externalId, mountPath), {
      method: 'DELETE',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DriveStorageError && err.status === 404) return;
    throw err;
  }
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Unmount a folder path inside the guest when the guest still has something
 * mounted there that Platinum no longer tracks (a VM resumed from memory keeps
 * the mounts its kernel had, after Platinum ended them at the stop).
 */
export async function unmountInGuest(externalId: string, mountPath: string): Promise<void> {
  const q = shellQuote(mountPath);
  await execInSandbox(externalId, `if mountpoint -q ${q}; then umount ${q} 2>/dev/null || umount -l ${q}; fi`);
}

/**
 * Run a short script as root in a running sandbox (the sandbox exec runs as
 * the runtime user, which has passwordless sudo). Throws on any failure.
 */
export async function execInSandbox(externalId: string, script: string, timeoutMs = 20_000): Promise<void> {
  let res: Response;
  try {
    res = await call(null, `/v1/sandboxes/${encodeURIComponent(externalId)}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd: ['bash', '-c', `sudo -n bash -c ${shellQuote(script)}`], timeout_ms: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
  } catch (err) {
    // The storage error copy is about files; an exec refusal is about the sandbox.
    throw new Error(`exec refused: ${err instanceof DriveStorageError ? `${err.status} ${err.code ?? ''}` : String(err)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { result?: { exit_code?: number; stderr?: string; error?: string } };
  const code = body.result?.exit_code;
  if (code !== 0) throw new Error(`exec exited ${code ?? '?'}: ${(body.result?.stderr ?? body.result?.error ?? '').slice(0, 200)}`);
}
