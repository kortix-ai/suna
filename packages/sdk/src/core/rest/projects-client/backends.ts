// Kortix Backends — project-scoped, self-hosted Convex backends (one machine each).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ProjectBackendStatus = 'provisioning' | 'running' | 'error' | 'deleted';

export type ProjectBackendOperation = 'resizing';

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
  /** Convex client URL (`CONVEX_URL`). `null` until the backend runs. */
  url: string | null;
  /** Convex HTTP actions URL. `null` until the backend runs. */
  site_url: string | null;
  cpu: number;
  memory_gb: number;
  disk_gb: number;
  error: string | null;
  /** A day-two operation in flight. `null` when idle. */
  operation: ProjectBackendOperation | null;
  /** Why the last operation failed. Cleared by the next operation. */
  last_operation_error: string | null;
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

export interface WaitForBackendOptions {
  /** Default 10 minutes: a region's first image build runs inside provisioning. */
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
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
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
 * A one-hour Kortix sign-in token for the backend, naming the caller. Inside a
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

export interface ProjectBackendSnapshot {
  snapshot_id: string;
  created_at: string;
  size_bytes: number | null;
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
}

export async function getBackendBackups(projectId: string, backendId: string): Promise<ProjectBackendBackups> {
  return unwrap(
    await backendApi.get<ProjectBackendBackups>(`/projects/${projectId}/backends/${backendId}/backups`),
    'Failed to load backend backups',
  );
}

/** Takes a snapshot now. The backend keeps the newest 5. */
export async function createBackendSnapshot(
  projectId: string,
  backendId: string,
): Promise<{ snapshot_id: string; created_at: string }> {
  return unwrap(
    await backendApi.post<{ snapshot_id: string; created_at: string }>(
      `/projects/${projectId}/backends/${backendId}/snapshots`,
      {},
    ),
    'Failed to snapshot backend',
  );
}

/** Rolls the backend back to a snapshot. Every change after it is lost. Answers `400` with `snapshot_not_found`. */
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
