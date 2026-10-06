// Kortix Backends — project-scoped, self-hosted Convex backends (one machine each).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ProjectBackendStatus = 'provisioning' | 'running' | 'error' | 'deleted';

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
  created_at: string;
  updated_at: string;
}

export interface CreateProjectBackendInput {
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
