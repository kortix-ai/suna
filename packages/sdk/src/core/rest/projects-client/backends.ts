// Kortix Backends — project-scoped, self-hosted Convex backends (one machine each).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ProjectBackendStatus = 'provisioning' | 'running' | 'error' | 'deleted';

/**
 * A day-two operation in flight. `rotating_key`: an admin-key rotation.
 * `recovering`: Kortix is starting the machine, or restoring it from its last
 * automatic backup, after a failed health probe or an interrupted operation.
 * `snapshotting`: a snapshot is taken or deleted (the machine pauses for the
 * copy). `restoring`: a snapshot restore.
 */
export type ProjectBackendOperation = 'resizing' | 'rotating_key' | 'recovering' | 'snapshotting' | 'restoring';

/** The last health probe of a running backend. Kortix probes every 5 minutes. */
export interface ProjectBackendHealth {
  ok: boolean;
  checked_at: string;
  /** The machine's state: `running`, `stopped`, `restoring`, …; `missing` when it no longer exists; `null` when the provider did not answer. */
  machine_state: string | null;
  /** Failed probes in a row. */
  failures: number;
  error: string | null;
  /** Percent of the machine disk in use, when known. */
  disk_used_pct: number | null;
  /** What the probe started to bring the machine back, if anything. */
  repair: 'started' | 'restored_from_backup' | null;
}

/** Machine size. Every field is optional on write. */
export interface ProjectBackendSize {
  /** 1 to 16. */
  cpu?: number;
  /** 1 to 32. */
  memory_gb?: number;
  /** 10 to 100. A disk never shrinks. */
  disk_gb?: number;
}

export interface ProjectBackend {
  backend_id: string;
  project_id: string;
  name: string;
  status: ProjectBackendStatus;
  /**
   * Convex client URL (`CONVEX_URL`): a Kortix host that stays the same for
   * the backend's life. `null` until the backend runs.
   */
  url: string | null;
  /** Convex HTTP actions URL, a second Kortix host. `null` until the backend runs. */
  site_url: string | null;
  /**
   * Convex's own dashboard for this backend, on a Kortix host. Frame it and
   * answer its `dashboard-credentials-request` message with
   * {@link getBackendCredentials}. `null` until the backend runs, and for a
   * backend created before the dashboard shipped.
   */
  dashboard_url: string | null;
  cpu: number;
  memory_gb: number;
  disk_gb: number;
  error: string | null;
  /** A day-two operation in flight. `null` when idle. */
  operation: ProjectBackendOperation | null;
  /** Why the last operation failed. Cleared by the next operation. */
  last_operation_error: string | null;
  /** The last health probe. `null` before the first one; absent on servers older than this field. */
  health?: ProjectBackendHealth | null;
  /**
   * Public values that verify this backend's member tokens: no secret. Put
   * them in the environment of any server that calls `verifyKortixMemberToken`.
   * `KORTIX_AUTH_ISSUER` is a public URL: `<issuer>/jwks.json` serves the same
   * key set as `KORTIX_AUTH_JWKS`, and `<issuer>/.well-known/openid-configuration`
   * names it. `null` for a backend created before Kortix sign-in; absent on servers
   * older than this field.
   */
  auth_env?: {
    KORTIX_AUTH_ISSUER: string;
    KORTIX_AUTH_AUDIENCE: string;
    KORTIX_AUTH_JWKS: string;
  } | null;
  /**
   * The `convex` npm CLI version that matches this backend's Convex build.
   * Deploy with it (`npx convex@<version> deploy`) when the project has no
   * `convex` installed. Absent on servers older than this field.
   */
  convex_version?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectBackendInput extends ProjectBackendSize {
  /** Lowercase letters, digits and dashes, starting with a letter (max 63). */
  name: string;
}

export interface ProjectBackendCredentials {
  url: string;
  site_url: string;
  admin_key: string;
  /** Ready-to-use variables for the Convex CLI: `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`. */
  env: Record<string, string>;
}

export async function listBackends(projectId: string): Promise<ProjectBackend[]> {
  return unwrap(
    await backendApi.get<{ backends: ProjectBackend[] }>(`/projects/${projectId}/backends`),
    'Failed to list backends',
  ).backends;
}

/**
 * Claims the name and starts the backend. Returns at once with status
 * `provisioning`; call {@link waitForBackend} for the running backend. Boot
 * takes seconds, or minutes on a region's first image build. Answers `409`
 * with `backend_limit` or `backend_name_taken`.
 */
export async function createBackend(
  projectId: string,
  input: CreateProjectBackendInput,
): Promise<ProjectBackend> {
  return unwrap(
    await backendApi.post<{ backend: ProjectBackend }>(`/projects/${projectId}/backends`, input),
    'Failed to create backend',
  ).backend;
}

export async function getBackend(projectId: string, backendId: string): Promise<ProjectBackend> {
  return unwrap(
    await backendApi.get<{ backend: ProjectBackend }>(`/projects/${projectId}/backends/${backendId}`),
    'Failed to load backend',
  ).backend;
}

/**
 * How long the API lets a provision run before it reports `error` (15 min).
 * A region's first image build (up to 10 min), the health wait and the admin
 * key mint all run inside provisioning, so a shorter wait gives up on a
 * backend that then becomes `running`.
 */
const BACKEND_PROVISION_WAIT_MS = 15 * 60_000;

export interface WaitForBackendOptions {
  /** Default 15 minutes: the API's own provisioning deadline. */
  timeoutMs?: number;
  /** Default 1 second. */
  intervalMs?: number;
}

/**
 * Polls a backend until it runs. Rejects with the backend's error when
 * provisioning fails, and after `timeoutMs` while it is still provisioning.
 */
export async function waitForBackend(
  projectId: string,
  backendId: string,
  options: WaitForBackendOptions = {},
): Promise<ProjectBackend> {
  const deadline = Date.now() + (options.timeoutMs ?? BACKEND_PROVISION_WAIT_MS);
  for (;;) {
    const backend = await getBackend(projectId, backendId);
    if (backend.status === 'running') return backend;
    if (backend.status !== 'provisioning') {
      throw new Error(backend.error ?? `Backend ${backend.name} is ${backend.status}`);
    }
    if (Date.now() >= deadline) throw new Error(`Backend ${backend.name} is still provisioning`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
  }
}

/** Admin credentials. Answers `409` with `backend_not_running` until the backend runs. */
export async function getBackendCredentials(
  projectId: string,
  backendId: string,
): Promise<ProjectBackendCredentials> {
  return unwrap(
    await backendApi.get<ProjectBackendCredentials>(
      `/projects/${projectId}/backends/${backendId}/credentials`,
    ),
    'Failed to load backend credentials',
  );
}

export interface ProjectBackendToken {
  /** ES256 JWT the backend accepts as `ctx.auth`; pass it to the Convex client's `setAuth`. */
  token: string;
  expires_at: string;
}

/**
 * A 15-minute Kortix sign-in token for the backend, naming the caller. Inside a
 * Convex function, `ctx.auth.getUserIdentity()` returns that member.
 */
export async function getBackendToken(projectId: string, backendId: string): Promise<ProjectBackendToken> {
  return unwrap(
    await backendApi.post<ProjectBackendToken>(`/projects/${projectId}/backends/${backendId}/token`, {}),
    'Failed to mint a backend token',
  );
}

export async function deleteBackend(projectId: string, backendId: string): Promise<void> {
  const response = await backendApi.delete(`/projects/${projectId}/backends/${backendId}`);
  if (!response.success) throw response.error ?? new Error('Failed to delete backend');
}

/**
 * Resizes the machine. Returns at once with `operation: 'resizing'`; call
 * {@link waitForBackendOperation} for the result. Answers `400` with
 * `invalid_size`, `disk_shrink_unsupported` or `size_unchanged`, and `409`
 * with `backend_busy` or `backend_not_running`.
 */
export async function resizeBackend(
  projectId: string,
  backendId: string,
  size: ProjectBackendSize,
): Promise<ProjectBackend> {
  return unwrap(
    await backendApi.patch<{ backend: ProjectBackend }>(`/projects/${projectId}/backends/${backendId}`, size),
    'Failed to resize backend',
  ).backend;
}

export interface WaitForBackendOperationOptions {
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** Default 1 second. */
  intervalMs?: number;
}

/**
 * Polls a backend until its `operation` clears. Rejects with
 * `last_operation_error` when it changed during the wait, and after
 * `timeoutMs` while the operation still runs.
 */
export async function waitForBackendOperation(
  projectId: string,
  backendId: string,
  options: WaitForBackendOperationOptions = {},
): Promise<ProjectBackend> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  let before: string | null | undefined;
  for (;;) {
    const backend = await getBackend(projectId, backendId);
    if (before === undefined) before = backend.last_operation_error;
    if (!backend.operation) {
      if (backend.last_operation_error && backend.last_operation_error !== before) {
        throw new Error(backend.last_operation_error);
      }
      return backend;
    }
    if (Date.now() >= deadline) throw new Error(`Backend ${backend.name} is still ${backend.operation}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
  }
}

/**
 * Who made a snapshot, which decides how long it stays. `manual`: a member or
 * agent took it; it stays until deleted. `automatic`: the daily snapshot, kept
 * 7 days. `resize`: taken before a resize, kept 24 hours.
 */
export type ProjectBackendSnapshotKind = 'manual' | 'automatic' | 'resize';

export interface ProjectBackendSnapshot {
  snapshot_id: string;
  created_at: string;
  size_bytes: number | null;
  /** Absent on servers older than this field: read it as `manual`. */
  kind?: ProjectBackendSnapshotKind;
  /**
   * When Kortix deletes the snapshot; `null` for a manual one. The newest
   * automatic snapshot stays past its expiry until a newer one exists.
   * Absent on servers older than this field.
   */
  expires_at?: string | null;
}

/** When Kortix takes and deletes snapshots on its own. */
export interface ProjectBackendSnapshotSchedule {
  automatic_interval_hours: number;
  automatic_retention_days: number;
  resize_retention_hours: number;
  /** The last automatic snapshot; `null` before the first. */
  last_automatic_at: string | null;
}

export interface ProjectBackendBackups {
  automatic: {
    state: string | null;
    last_backup_at: string | null;
    size_bytes: number | null;
    interval_minutes: number | null;
  };
  /** Newest first. */
  snapshots: ProjectBackendSnapshot[];
  /**
   * How many manual snapshots the backend holds. At the limit a new one
   * answers `409 snapshot_limit`; nothing is dropped. Older servers sent the
   * total kept (5). Absent on servers older than this field.
   */
  snapshot_limit?: number;
  /** Absent on servers older than this field. */
  snapshot_schedule?: ProjectBackendSnapshotSchedule;
}

export async function getBackendBackups(projectId: string, backendId: string): Promise<ProjectBackendBackups> {
  return unwrap(
    await backendApi.get<ProjectBackendBackups>(`/projects/${projectId}/backends/${backendId}/backups`),
    'Failed to load backend backups',
  );
}

/**
 * Takes a manual snapshot now; it stays until deleted. Answers `409` with
 * `snapshot_limit` when the backend holds its limit of manual snapshots
 * (delete one with {@link deleteBackendSnapshot}), and `backend_busy` while
 * another operation runs. Servers since snapshot kinds also return
 * `size_bytes`, `kind` and `expires_at`.
 */
export async function createBackendSnapshot(
  projectId: string,
  backendId: string,
): Promise<{ snapshot_id: string; created_at: string } & Partial<ProjectBackendSnapshot>> {
  return unwrap(
    await backendApi.post<{ snapshot_id: string; created_at: string } & Partial<ProjectBackendSnapshot>>(
      `/projects/${projectId}/backends/${backendId}/snapshots`,
      {},
    ),
    'Failed to snapshot backend',
  );
}

/**
 * Deletes one snapshot of any kind and frees its storage. This cannot be
 * undone. Answers `404` with `snapshot_not_found` and `409` with `backend_busy`.
 */
export async function deleteBackendSnapshot(projectId: string, backendId: string, snapshotId: string): Promise<void> {
  const response = await backendApi.delete(
    `/projects/${projectId}/backends/${backendId}/snapshots/${encodeURIComponent(snapshotId)}`,
  );
  if (!response.success) throw response.error ?? new Error('Failed to delete the backend snapshot');
}

/**
 * Replaces the admin key: every key read before stops working. Convex restarts
 * (about 1 s). Data, files and environment variables stay. Read the new key
 * with {@link getBackendCredentials}. Answers `409` with `backend_busy` or
 * `backend_not_running`.
 */
export async function rotateBackendAdminKey(projectId: string, backendId: string): Promise<ProjectBackend> {
  return unwrap(
    await backendApi.post<{ backend: ProjectBackend }>(
      `/projects/${projectId}/backends/${backendId}/rotate-admin-key`,
      {},
    ),
    'Failed to rotate the backend admin key',
  ).backend;
}

export interface GetBackendLogsOptions {
  /** 1 to 1000. Default 200. */
  lines?: number;
}

/**
 * The last lines of the Convex process log (startup, crashes, restarts,
 * request lines), newest last. Function logs are in the dashboard and in
 * `npx convex logs`.
 */
export async function getBackendLogs(
  projectId: string,
  backendId: string,
  options: GetBackendLogsOptions = {},
): Promise<string> {
  return unwrap(
    await backendApi.get<{ log: string }>(
      `/projects/${projectId}/backends/${backendId}/logs?lines=${options.lines ?? 200}`,
    ),
    'Failed to read the backend log',
  ).log;
}

/**
 * Rolls the backend back to a snapshot. Every change after it is lost. Resolves
 * once the machine runs the snapshot and Convex answers. Answers `400` with
 * `snapshot_not_found`, `409` with `snapshot_predates_resize` (taken before a
 * resize: it holds the old machine size) or `backend_busy`, and `502` with
 * `restore_unhealthy`.
 */
export async function restoreBackendSnapshot(
  projectId: string,
  backendId: string,
  snapshotId: string,
): Promise<ProjectBackend> {
  return unwrap(
    await backendApi.post<{ backend: ProjectBackend }>(
      `/projects/${projectId}/backends/${backendId}/restore`,
      { snapshot_id: snapshotId },
    ),
    'Failed to restore backend',
  ).backend;
}
