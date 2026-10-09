// The storage behind a drive: one Platinum volume in drive sync mode. Every
// call here speaks the Platinum volumes API; nothing above this file does.

import { logger } from '../lib/logger';
import { isPlatinumConfigured, platinumFetch } from '../shared/platinum';
import { DEFAULT_SANDBOX_MOUNT_LIMIT } from './access';

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

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  if (!driveStorageAvailable()) throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
  let res: Response;
  try {
    res = await platinumFetch(path, init);
  } catch (err) {
    logger.warn(`[drives] ${init.method ?? 'GET'} ${path} failed:`, { error: err instanceof Error ? err.message : String(err) });
    throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', 'drive_storage_unavailable');
  }
  if (res.ok) return res;
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
      throw new DriveStorageError(409, 'A file or folder with that name already exists', code);
    case 413:
      throw new DriveStorageError(413, 'File is too large', code);
    default:
      logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', code);
  }
}

async function callJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await call(path, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const v = (volume: string) => `/v1/volumes/${encodeURIComponent(volume)}`;

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

/** Open-or-create by name, so a retry after a lost response never makes a second volume. */
export async function openDriveVolume(name: string, signal?: AbortSignal): Promise<VolumeInfo> {
  try {
    return await callJson<VolumeInfo>(v(name), {
      method: 'PUT',
      body: JSON.stringify({ sync_mode: 'drive' }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // A 404 here means volumes are not enabled for the storage account: not a
    // missing file, and not the caller's to fix.
    if (err instanceof DriveStorageError && (err.status === 404 || err.status === 400)) {
      throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
    }
    throw err;
  }
}

export async function getDriveVolume(volume: string, signal?: AbortSignal): Promise<VolumeInfo> {
  return callJson<VolumeInfo>(v(volume), signal ? { signal } : {});
}

export async function deleteDriveVolume(volume: string): Promise<void> {
  await call(`${v(volume)}?missing_ok=true`, { method: 'DELETE' });
}

export interface VolumeEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
}

export async function listVolumeFiles(
  volume: string,
  path: string,
  recursive: boolean,
  signal?: AbortSignal,
): Promise<VolumeEntry[]> {
  const q = new URLSearchParams({ path, recursive: String(recursive), limit: '10000' });
  const r = await callJson<{ entries: VolumeEntry[] }>(`${v(volume)}/files?${q}`, signal ? { signal } : {});
  return r.entries ?? [];
}

export async function readVolumeFile(volume: string, path: string, range?: string): Promise<Response> {
  const q = new URLSearchParams({ path });
  return call(`${v(volume)}/files/content?${q}`, {
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    headers: range ? { Range: range } : {},
  });
}

export async function writeVolumeFile(
  volume: string,
  path: string,
  body: Uint8Array<ArrayBuffer>,
  opts: { overwrite: boolean },
): Promise<{ path: string; size: number; version?: string }> {
  const q = new URLSearchParams({ path, overwrite: String(opts.overwrite) });
  const r = await callJson<{ path: string; size: number; version?: string }>(`${v(volume)}/files/content?${q}`, {
    method: 'PUT',
    body,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  return { path: r.path ?? path, size: Number(r.size ?? body.byteLength), ...(r.version ? { version: String(r.version) } : {}) };
}

/** One page of a listing, for callers that walk a whole drive (drive sync). */
export async function listVolumeFilesPage(
  volume: string,
  path: string,
  opts: { recursive: boolean; cursor?: string; signal?: AbortSignal },
): Promise<{ entries: VolumeEntry[]; next_cursor: string | null }> {
  const q = new URLSearchParams({ path, recursive: String(opts.recursive), limit: '5000' });
  if (opts.cursor) q.set('cursor', opts.cursor);
  const r = await callJson<{ entries: VolumeEntry[]; next_cursor?: string | null }>(
    `${v(volume)}/files?${q}`,
    opts.signal ? { signal: opts.signal } : {},
  );
  return { entries: r.entries ?? [], next_cursor: r.next_cursor ?? null };
}

export interface VolumeFileStat extends VolumeEntry {
  version: string | null;
}

export async function statVolumeFile(volume: string, path: string): Promise<VolumeFileStat> {
  const q = new URLSearchParams({ path });
  const r = await callJson<VolumeFileStat>(`${v(volume)}/files/stat?${q}`, { signal: AbortSignal.timeout(30_000) });
  return { path: r.path, type: r.type, size: Number(r.size ?? 0), mtime: Number(r.mtime ?? 0), version: r.version ?? null };
}

/**
 * The block upload protocol, for files too large for one PUT: plan (the
 * store answers which 1 MiB blocks it lacks), send only those, commit.
 */
export async function planVolumeUpload(volume: string, plan: unknown): Promise<unknown> {
  return callJson<unknown>(`${v(volume)}/files/upload`, {
    method: 'POST',
    body: JSON.stringify(plan),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

export async function putVolumeUploadBlock(volume: string, uploadId: string, sha: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  await call(`${v(volume)}/files/upload/${encodeURIComponent(uploadId)}/blocks/${encodeURIComponent(sha)}`, {
    method: 'PUT',
    body,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

export async function commitVolumeUpload(volume: string, uploadId: string): Promise<unknown> {
  return callJson<unknown>(`${v(volume)}/files/upload/${encodeURIComponent(uploadId)}/commit`, {
    method: 'POST',
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

export async function moveVolumeFile(volume: string, src: string, dst: string): Promise<void> {
  await call(`${v(volume)}/files/move`, {
    method: 'POST',
    body: JSON.stringify({ src, dst, overwrite: false }),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

export async function removeVolumeFile(volume: string, path: string, recursive: boolean): Promise<void> {
  const q = new URLSearchParams({ path, recursive: String(recursive) });
  await call(`${v(volume)}/files?${q}`, { method: 'DELETE', signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
}

export interface VolumeCommit {
  id: string;
  kind: string;
  author: { kind: string; id: string | null };
  created_at: string;
  stats?: { changed_paths?: number; deleted_paths?: number };
}

export async function listVolumeCommits(volume: string, limit = 100): Promise<VolumeCommit[]> {
  const r = await callJson<{ commits: VolumeCommit[] }>(`${v(volume)}/commits?limit=${limit}`);
  return r.commits ?? [];
}

export async function restoreVolume(volume: string, to: string): Promise<void> {
  await call(`${v(volume)}/restore`, { method: 'POST', body: JSON.stringify({ to }) });
}

let mountLimitCache: { value: number; at: number } | null = null;
const MOUNT_LIMIT_TTL_MS = 10 * 60_000;

/**
 * How many volumes one sandbox may mount, from Platinum's own limits (never
 * above its hard cap of {@link DEFAULT_SANDBOX_MOUNT_LIMIT}). Cached; falls
 * back to that cap when the limits cannot be read.
 */
export async function sandboxMountLimit(): Promise<number> {
  if (mountLimitCache && Date.now() - mountLimitCache.at < MOUNT_LIMIT_TTL_MS) return mountLimitCache.value;
  let value = DEFAULT_SANDBOX_MOUNT_LIMIT;
  try {
    const limits = await callJson<{ max_mounts_per_sandbox?: number }>('/v1/volumes/limits', {
      signal: AbortSignal.timeout(5_000),
    });
    const max = Number(limits.max_mounts_per_sandbox);
    if (Number.isFinite(max) && max >= 1) value = Math.min(DEFAULT_SANDBOX_MOUNT_LIMIT, Math.floor(max));
  } catch (err) {
    logger.warn('[drives] reading the sandbox mount limit failed:', { error: err instanceof Error ? err.message : String(err) });
    return value;
  }
  mountLimitCache = { value, at: Date.now() };
  return value;
}

/** The volume mounts a sandbox has now, by mount path, or null when Platinum cannot say. */
export async function sandboxMountPaths(externalId: string): Promise<string[] | null> {
  try {
    const body = await callJson<{ volume_mounts?: Array<{ mount_path?: string; path?: string }> | Record<string, unknown> }>(
      `/v1/sandboxes/${encodeURIComponent(externalId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const mounts = body.volume_mounts;
    if (!mounts) return [];
    if (Array.isArray(mounts)) return mounts.map((m) => String(m.mount_path ?? m.path ?? ''));
    return Object.keys(mounts);
  } catch {
    return null;
  }
}

const sandboxMount = (externalId: string, mountPath: string) =>
  `/v1/sandboxes/${encodeURIComponent(externalId)}/volumes/${encodeURIComponent(mountPath)}`;

/**
 * Hot-attach a volume to a running sandbox. Platinum answers 201 once the
 * guest mounted it, 202 while the mount is still pending (it lands within
 * seconds); both count as attached.
 */
export async function attachSandboxVolume(
  externalId: string,
  mountPath: string,
  input: { volume: string; readOnly: boolean; subdir?: string },
): Promise<void> {
  try {
    await call(sandboxMount(externalId, mountPath), {
      method: 'POST',
      body: JSON.stringify({
        volume: input.volume,
        read_only: input.readOnly,
        ...(input.subdir ? { subdir: input.subdir } : {}),
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
    await call(sandboxMount(externalId, mountPath), {
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
 * Run a short script as root in a running sandbox (the sandbox exec runs as
 * the runtime user, which has passwordless sudo). Throws on any failure.
 */
export async function execInSandbox(externalId: string, script: string, timeoutMs = 20_000): Promise<void> {
  let res: Response;
  try {
    res = await call(`/v1/sandboxes/${encodeURIComponent(externalId)}/exec`, {
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
