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

export const SANDBOX_PORTS = {
  DESKTOP: '6080',
  DESKTOP_HTTPS: '6081',
  KORTIX_MASTER: '8000',
  BROWSER_STREAM: '9223',
  SSH: '22',
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
 * Ensure the user has a sandbox provisioned. Creates one if needed.
 * POST /platform/init
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
 * GET /platform/sandbox
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
 *
 * GET /platform/sandbox/list — cloud-tracked sandboxes from the DB.
 * Additionally probes /platform/local-bridge/status so a live local Docker
 * sandbox surfaces alongside cloud instances. The bridge call also ensures
 * the backend creates/updates the local sandbox's DB row on self-hosted setups.
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
 * Discover the local Docker sandbox (if any) by hitting the backend's
 * local-bridge status endpoint. Returns null if no local sandbox is running
 * or the endpoint is unreachable.
 *
 * GET /platform/local-bridge/status
 */
export async function discoverLocalSandbox(): Promise<SandboxInfo | null> {
  return null;
}

/**
 * Restart the active sandbox.
 * POST /platform/sandbox/restart
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
 * Stop the active sandbox.
 * POST /platform/sandbox/stop
 */
export async function stopSandbox(): Promise<void> {
  throw new Error('Stopping project-session sandboxes is not supported by the current API');
}

/**
 * Delete/archive a sandbox by ID.
 * DELETE /platform/sandbox/:sandboxId
 */
export async function deleteSandbox(sandboxId: string): Promise<void> {
  const row = await findProjectSessionSandbox(sandboxId);
  if (!row) throw new Error('Project session sandbox not found');
  await apiFetch<void>(
    `/projects/${encodeURIComponent(row.project.project_id)}/sessions/${encodeURIComponent(row.session.session_id)}`,
    { method: 'DELETE' },
  );
}

/**
 * Get available sandbox providers.
 * GET /platform/providers
 */
export async function getProviders(): Promise<string[]> {
  return ['daytona'];
}

/**
 * Initialize a local Docker sandbox.
 * POST /platform/init/local
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

/**
 * Add a custom URL instance to the server store.
 * POST /platform/sandbox with custom URL.
 * For now this is a local-only operation — custom URLs are stored on-device.
 */
export interface CustomInstance {
  id: string;
  label: string;
  url: string;
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

// ─── Sandbox Update API ─────────────────────────────────────────────────────

export interface ChangelogChange {
  type: 'feature' | 'fix' | 'improvement' | 'breaking' | 'upstream' | 'security' | 'deprecation';
  text: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  description: string;
  changes: ChangelogChange[];
}

export interface SandboxVersionInfo {
  version: string;
  channel?: string;
  changelog: ChangelogEntry | null;
}

export type UpdatePhase =
  | 'idle'
  | 'pulling'
  | 'stopping'
  | 'removing'
  | 'recreating'
  | 'starting'
  | 'health_check'
  | 'complete'
  | 'failed';

export interface SandboxUpdateStatus {
  phase: UpdatePhase;
  progress: number;
  message: string;
  targetVersion: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export async function getLatestSandboxVersion(): Promise<SandboxVersionInfo> {
  const res = await fetch(`${API_URL}/platform/sandbox/version/latest`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Version check failed: ${res.status}`);
  const data = await res.json();
  // Handle nested response: { data: { version, changelog } } or direct { version, changelog }
  const info = data?.data ?? data;
  return {
    version: info.version,
    channel: info.channel,
    changelog: info.changelog ?? null,
  };
}

export type VersionChannel = 'stable' | 'dev';

export interface VersionEntry {
  version: string;
  channel: VersionChannel;
  date: string;
  title: string;
  body?: string;
  sha?: string;
  current: boolean;
}

export interface AllVersionsResponse {
  versions: VersionEntry[];
  current: {
    version: string;
    channel: VersionChannel;
  };
}

export async function getAllVersions(): Promise<AllVersionsResponse> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}/platform/sandbox/version/all`, { headers });
  if (!res.ok) throw new Error(`All versions fetch failed: ${res.status}`);
  return res.json();
}

export async function getFullChangelog(): Promise<ChangelogEntry[]> {
  try {
    const token = await getAuthToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_URL}/platform/sandbox/version/changelog`, { headers });
    if (!res.ok) throw new Error(`Changelog fetch failed: ${res.status}`);
    const data = await res.json();

    // Handle various response shapes
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.changelog)) return data.changelog;
    if (data.data && Array.isArray(data.data.changelog)) return data.data.changelog;
    if (data.data && Array.isArray(data.data)) return data.data;
    return [];
  } catch {
    return [];
  }
}

export async function triggerSandboxUpdate(_version: string): Promise<void> {
  throw new Error('Sandbox image updates are managed by project-session provisioning in the current API');
}

export async function getSandboxUpdateStatus(): Promise<SandboxUpdateStatus> {
  return {
    phase: 'idle',
    progress: 0,
    message: 'Project-session sandboxes do not expose legacy update status',
    targetVersion: null,
    previousVersion: null,
    currentVersion: null,
    error: null,
    startedAt: null,
    updatedAt: null,
  };
}

export async function resetSandboxUpdateStatus(): Promise<void> {
  return;
}

// ─── SSH API ────────────────────────────────────────────────────────────────

export interface SSHConnectionInfo {
  host: string;
  port: number;
  username: string;
  provider: string;
  key_name: string;
  host_alias: string;
  reconnect_command: string;
  ssh_command: string;
  ssh_config_entry: string;
  ssh_config_command: string;
}

export interface SSHSetupResult extends SSHConnectionInfo {
  private_key: string;
  public_key: string;
  setup_command: string;
  agent_prompt: string;
  key_comment: string;
}

export async function setupSSH(): Promise<SSHSetupResult> {
  throw new Error('SSH setup is not exposed for project-session sandboxes');
}

export async function getSSHConnection(): Promise<SSHConnectionInfo> {
  throw new Error('SSH connection details are not exposed for project-session sandboxes');
}

// ─── Running Services API ───────────────────────────────────────────────────

export type SandboxServiceStatus = 'running' | 'stopped' | 'starting' | 'failed' | 'backoff';
export type SandboxServiceAdapter = 'spawn' | 's6';
export type SandboxServiceScope = 'bootstrap' | 'core' | 'project' | 'session';

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

export async function sandboxRuntimeReload(
  sandboxUrl: string,
  mode: 'dispose-only' | 'full',
): Promise<boolean> {
  const data = await serviceRequest(sandboxUrl, `/kortix/services/system/reload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  return data !== null;
}

/** @deprecated Use sandboxServiceAction instead */
export async function stopSandboxService(sandboxUrl: string, serviceId: string): Promise<boolean> {
  return sandboxServiceAction(sandboxUrl, serviceId, 'stop');
}

export interface PtySession {
  id: string;
  running: boolean;
  command?: string;
  args?: string[];
  createdAt?: string;
}

export async function getPtySessions(sandboxUrl: string): Promise<PtySession[]> {
  try {
    const token = await getAuthToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${sandboxUrl}/pty`, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json();
    // Response could be array directly or wrapped
    if (Array.isArray(data)) return data;
    if (data?.ptys && Array.isArray(data.ptys)) return data.ptys;
    if (data?.data && Array.isArray(data.data)) return data.data;
    return [];
  } catch {
    return [];
  }
}
