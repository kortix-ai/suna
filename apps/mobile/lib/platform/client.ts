/**
 * Platform API Client for Kortix Computer Mobile
 *
 * Communicates with the Computer backend to manage sandbox lifecycle
 * and provides the sandbox URL for OpenCode session operations.
 *
 * All sandbox operations are proxied through:
 *   {BACKEND_URL}/p/{sandboxId}/{containerPort}
 */

import { API_URL, getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';

// ─── Port Constants ──────────────────────────────────────────────────────────

const SANDBOX_PORTS = {
  DESKTOP: '6080',
  DESKTOP_HTTPS: '6081',
  KORTIX_MASTER: '8000',
  BROWSER_STREAM: '9223',
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SandboxProviderName = 'daytona' | 'local_docker' | 'justavps';

export interface SandboxInfo {
  sandbox_id: string;
  external_id: string;
  name: string;
  provider: SandboxProviderName;
  base_url: string;
  status: string;
  version?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ProjectSummary {
  project_id: string;
  account_id: string;
  name: string;
  updated_at: string;
}

interface ProjectSessionSummary {
  session_id: string;
  account_id: string;
  project_id: string;
  sandbox_provider: SandboxProviderName | null;
  sandbox_id: string;
  sandbox_url: string | null;
  name: string | null;
  status: string;
  error: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ProjectSessionSandbox {
  sandbox_id: string;
  session_id: string;
  project_id: string;
  account_id: string;
  provider: SandboxProviderName;
  external_id: string | null;
  base_url: string | null;
  status: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the OpenCode server URL for a sandbox.
 * Pattern: {BACKEND_URL}/p/{externalId}/8000
 */
export function getSandboxUrl(sandboxExternalId: string): string {
  return `${API_URL}/p/${sandboxExternalId}/${SANDBOX_PORTS.KORTIX_MASTER}`;
}

/**
 * Build a URL to any port on the sandbox.
 */
export function getSandboxPortUrl(sandboxExternalId: string, port: string): string {
  return `${API_URL}/p/${sandboxExternalId}/${port}`;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAuthToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(body?.error || body?.message || `API error ${res.status}`);
  }
  return body as T;
}

function normalizeSessionStatus(status: string | undefined): string {
  if (status === 'running') return 'active';
  if (status === 'queued' || status === 'branching' || status === 'provisioning') return 'provisioning';
  if (status === 'failed') return 'error';
  if (status === 'stopped' || status === 'completed') return 'stopped';
  return status || 'unknown';
}

function toSandboxInfo(
  project: ProjectSummary,
  session: ProjectSessionSummary,
  runtime?: ProjectSessionSandbox | null,
): SandboxInfo {
  const externalId = runtime?.external_id || session.sandbox_url?.match(/\/p\/([^/]+)\//)?.[1] || session.sandbox_id;
  const status = normalizeSessionStatus(runtime?.status || session.status);
  return {
    sandbox_id: runtime?.sandbox_id || session.sandbox_id || session.session_id,
    external_id: externalId,
    name: session.name || `${project.name} session`,
    provider: runtime?.provider || session.sandbox_provider || 'daytona',
    base_url: runtime?.base_url || session.sandbox_url || (runtime?.external_id ? getSandboxUrl(runtime.external_id) : ''),
    status,
    version: null,
    metadata: {
      ...(session.metadata || {}),
      project_id: project.project_id,
      session_id: session.session_id,
      project_name: project.name,
      error: session.error,
      runtime_status: runtime?.status,
    },
    created_at: runtime?.created_at || session.created_at,
    updated_at: runtime?.updated_at || session.updated_at,
  };
}

async function listProjects(): Promise<ProjectSummary[]> {
  return apiFetch<ProjectSummary[]>('/projects');
}

async function listProjectSessions(projectId: string): Promise<ProjectSessionSummary[]> {
  return apiFetch<ProjectSessionSummary[]>(`/projects/${encodeURIComponent(projectId)}/sessions`);
}

async function getProjectSessionSandbox(
  projectId: string,
  sessionId: string,
): Promise<ProjectSessionSandbox | null> {
  try {
    return await apiFetch<ProjectSessionSandbox>(
      `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/sandbox`,
    );
  } catch {
    return null;
  }
}

async function listProjectSessionSandboxes(): Promise<Array<{
  project: ProjectSummary;
  session: ProjectSessionSummary;
  runtime: ProjectSessionSandbox | null;
  sandbox: SandboxInfo;
}>> {
  const projects = await listProjects();
  const results: Array<{
    project: ProjectSummary;
    session: ProjectSessionSummary;
    runtime: ProjectSessionSandbox | null;
    sandbox: SandboxInfo;
  }> = [];

  for (const project of projects) {
    const sessions = await listProjectSessions(project.project_id).catch(() => []);
    for (const session of sessions) {
      const runtime = await getProjectSessionSandbox(project.project_id, session.session_id);
      results.push({
        project,
        session,
        runtime,
        sandbox: toSandboxInfo(project, session, runtime),
      });
    }
  }

  return results.sort((a, b) => {
    const priority: Record<string, number> = { active: 0, provisioning: 1, stopped: 2, error: 3 };
    const statusDelta = (priority[a.sandbox.status] ?? 99) - (priority[b.sandbox.status] ?? 99);
    if (statusDelta !== 0) return statusDelta;
    return Date.parse(b.sandbox.updated_at) - Date.parse(a.sandbox.updated_at);
  });
}

export async function findProjectSessionSandbox(sandboxId?: string): Promise<{
  project: ProjectSummary;
  session: ProjectSessionSummary;
  runtime: ProjectSessionSandbox | null;
  sandbox: SandboxInfo;
} | null> {
  const rows = await listProjectSessionSandboxes();
  if (!sandboxId) return rows[0] ?? null;
  return rows.find((row) =>
    row.sandbox.sandbox_id === sandboxId ||
    row.sandbox.external_id === sandboxId ||
    row.session.session_id === sandboxId ||
    row.runtime?.external_id === sandboxId
  ) ?? null;
}

// ─── API Methods ─────────────────────────────────────────────────────────────

/**
 * Ensure the user has a project-session sandbox provisioned.
 */
export async function ensureSandbox(opts?: {
  provider?: SandboxProviderName;
  projectId?: string;
}): Promise<{ sandbox: SandboxInfo; created: boolean }> {
  log.log('📦 [Platform] Ensuring sandbox...');

  const existing = await getActiveSandbox();
  if (existing) return { sandbox: existing, created: false };

  const projects = await listProjects();
  const project = opts?.projectId
    ? projects.find((item) => item.project_id === opts.projectId)
    : projects[0];
  if (!project) {
    throw new Error('Create a project before starting a sandbox');
  }

  const session = await apiFetch<ProjectSessionSummary>(`/projects/${encodeURIComponent(project.project_id)}/sessions`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const runtime = await getProjectSessionSandbox(project.project_id, session.session_id);
  const sandbox = toSandboxInfo(project, session, runtime);

  log.log('✅ [Platform] Project session sandbox ensured:', sandbox.external_id);
  return { sandbox, created: true };
}

/**
 * Get user's active sandbox.
 */
export async function getActiveSandbox(): Promise<SandboxInfo | null> {
  try {
    const row = await findProjectSessionSandbox();
    return row?.sandbox ?? null;
  } catch {
    return null;
  }
}

/**
 * List all sandboxes for the user.
 */
export async function listSandboxes(sandboxId?: string): Promise<SandboxInfo[]> {
  try {
    const rows = await listProjectSessionSandboxes();
    return rows
      .map((row) => row.sandbox)
      .filter((sandbox) =>
        !sandboxId ||
        sandbox.sandbox_id === sandboxId ||
        sandbox.external_id === sandboxId
      );
  } catch {
    return [];
  }
}

/**
 * Restart the active sandbox.
 */
export async function restartSandbox(sandboxId?: string): Promise<void> {
  const row = await findProjectSessionSandbox(sandboxId);
  if (!row) throw new Error('No project session sandbox found');
  await apiFetch<void>(
    `/projects/${encodeURIComponent(row.project.project_id)}/sessions/${encodeURIComponent(row.session.session_id)}/restart`,
    {
    method: 'POST',
    },
  );
}

/**
 * Get sandbox providers supported by the project-session flow.
 */
export async function getProviders(): Promise<string[]> {
  return ['daytona'];
}

/**
 * Start a project-session sandbox and emit legacy progress updates.
 */
export interface LocalSandboxProgress {
  status: string;
  progress: number;
  message: string;
}

export async function initLocalSandbox(
  _name?: string,
  onProgress?: (progress: LocalSandboxProgress) => void,
): Promise<SandboxInfo> {
  onProgress?.({ status: 'starting', progress: 0, message: 'Starting project session...' });
  const result = await ensureSandbox();
  onProgress?.({ status: result.sandbox.status, progress: result.sandbox.status === 'active' ? 100 : 25, message: 'Project session started' });
  return result.sandbox;
}

export async function checkInstanceHealth(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url}/kortix/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.version ?? null;
  } catch {
    return null;
  }
}

// ─── Running Services API ───────────────────────────────────────────────────

type SandboxServiceStatus = 'running' | 'stopped' | 'starting' | 'failed' | 'backoff';
type SandboxServiceAdapter = 'spawn' | 's6';
type SandboxServiceScope = 'bootstrap' | 'core' | 'project' | 'session';

export interface SandboxService {
  id: string;
  name: string;
  port: number;
  pid: number;
  framework: string;
  sourcePath: string;
  startedAt: string;
  status: SandboxServiceStatus;
  managed: boolean;
  adapter?: SandboxServiceAdapter;
  scope?: SandboxServiceScope;
  desiredState?: 'running' | 'stopped';
  builtin?: boolean;
  autoStart?: boolean;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'delete';

async function serviceRequest<T = any>(
  sandboxUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const token = await getAuthToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init?.headers as Record<string, string> || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${sandboxUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function getSandboxServices(
  sandboxUrl: string,
  includeAll = false,
): Promise<SandboxService[]> {
  const query = includeAll ? '?all=true' : '';
  const data = await serviceRequest<{ services?: SandboxService[] }>(
    sandboxUrl,
    `/kortix/services${query}`,
  );
  return data?.services ?? [];
}

export async function sandboxServiceAction(
  sandboxUrl: string,
  serviceId: string,
  action: ServiceAction,
): Promise<boolean> {
  const isDelete = action === 'delete';
  const method = isDelete ? 'DELETE' : 'POST';
  const path = isDelete
    ? `/kortix/services/${encodeURIComponent(serviceId)}`
    : `/kortix/services/${encodeURIComponent(serviceId)}/${action}`;
  const data = await serviceRequest(sandboxUrl, path, { method });
  return data !== null;
}

export async function getSandboxServiceLogs(
  sandboxUrl: string,
  serviceId: string,
): Promise<string[]> {
  const data = await serviceRequest<{ logs?: string[] }>(
    sandboxUrl,
    `/kortix/services/${encodeURIComponent(serviceId)}/logs`,
  );
  return data?.logs ?? [];
}

export async function reconcileSandboxServices(
  sandboxUrl: string,
  reload = false,
): Promise<boolean> {
  const query = reload ? '?reload=true' : '';
  const data = await serviceRequest(sandboxUrl, `/kortix/services/reconcile${query}`, {
    method: 'POST',
  });
  return data !== null;
}
