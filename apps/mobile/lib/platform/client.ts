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

interface PlatformResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  created?: boolean;
}

interface LocalBridgeSandboxResponse {
  success: boolean;
  status?: string;
  data?: SandboxInfo | null;
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

async function platformFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<PlatformResponse<T>> {
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

  const body = await res.json();

  if (!res.ok) {
    throw new Error(body?.error || body?.message || `Platform API error ${res.status}`);
  }

  return body as PlatformResponse<T>;
}

// ─── API Methods ─────────────────────────────────────────────────────────────

/**
 * Ensure the user has a sandbox provisioned. Creates one if needed.
 * POST /platform/init
 */
export async function ensureSandbox(opts?: {
  provider?: SandboxProviderName;
}): Promise<{ sandbox: SandboxInfo; created: boolean }> {
  log.log('📦 [Platform] Ensuring sandbox...');
  const result = await platformFetch<SandboxInfo>('/platform/init', {
    method: 'POST',
    body: opts?.provider ? JSON.stringify({ provider: opts.provider }) : undefined,
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to ensure sandbox');
  }

  log.log('✅ [Platform] Sandbox ensured:', result.data.external_id);
  return { sandbox: result.data, created: result.created ?? false };
}

/**
 * Get user's active sandbox.
 * GET /platform/sandbox
 */
export async function getActiveSandbox(): Promise<SandboxInfo | null> {
  try {
    const result = await platformFetch<SandboxInfo>('/platform/sandbox', {
      method: 'GET',
    });

    if (!result.success || !result.data) {
      return null;
    }

    return result.data;
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
    const qs = sandboxId ? `?sandbox_id=${encodeURIComponent(sandboxId)}` : '';
    const result = await platformFetch<SandboxInfo[]>(`/platform/sandbox/list${qs}`, {
      method: 'GET',
    });

    const rows = result.success && result.data ? result.data : [];
    const discoveredLocal = await discoverLocalSandbox();
    if (!discoveredLocal) return rows;
    if (sandboxId && discoveredLocal.sandbox_id !== sandboxId) return rows;

    const withoutDuplicate = rows.filter((s) => s.sandbox_id !== discoveredLocal.sandbox_id);
    return [discoveredLocal, ...withoutDuplicate];
  } catch {
    const discoveredLocal = await discoverLocalSandbox().catch(() => null);
    if (!discoveredLocal) return [];
    if (sandboxId && discoveredLocal.sandbox_id !== sandboxId) return [];
    return [discoveredLocal];
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
  try {
    const token = await getAuthToken();
    if (!token) return null;

    const res = await fetch(`${API_URL}/platform/local-bridge/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;

    const body = (await res.json()) as LocalBridgeSandboxResponse;
    if (!body.success || body.status !== 'ready' || !body.data?.sandbox_id) {
      return null;
    }
    return body.data;
  } catch {
    return null;
  }
}

/**
 * Restart the active sandbox.
 * POST /platform/sandbox/restart
 */
export async function restartSandbox(): Promise<void> {
  await platformFetch<void>('/platform/sandbox/restart', {
    method: 'POST',
  });
}

/**
 * Stop the active sandbox.
 * POST /platform/sandbox/stop
 */
export async function stopSandbox(): Promise<void> {
  await platformFetch<void>('/platform/sandbox/stop', {
    method: 'POST',
  });
}

/**
 * Delete/archive a sandbox by ID.
 * DELETE /platform/sandbox/:sandboxId
 */
export async function deleteSandbox(sandboxId: string): Promise<void> {
  await platformFetch<void>(`/platform/sandbox/${sandboxId}`, {
    method: 'DELETE',
  });
}

/**
 * Get available sandbox providers.
 * GET /platform/providers
 */
export async function getProviders(): Promise<string[]> {
  const result = await platformFetch<any>('/platform/providers', {
    method: 'GET',
  });
  const data = result.data;
  if (Array.isArray(data)) return data;
  // Some backends return { providers: [...] }
  if (data && Array.isArray(data.providers)) return data.providers;
  return [];
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
  name?: string,
  onProgress?: (progress: LocalSandboxProgress) => void,
): Promise<SandboxInfo> {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated');

  onProgress?.({ status: 'starting', progress: 0, message: 'Initializing...' });

  const res = await fetch(`${API_URL}/platform/init/local`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: name ? JSON.stringify({ name }) : undefined,
  });

  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || body?.message || 'Failed to init local sandbox');

  // If already ready, return immediately
  if (body.data?.status === 'ready' || body.data?.status === 'running') {
    onProgress?.({ status: 'ready', progress: 100, message: 'Connected' });
    return body.data as SandboxInfo;
  }

  // Poll for progress
  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const statusRes = await fetch(`${API_URL}/platform/init/local/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const statusBody = await statusRes.json();
    const data = statusBody.data;
    const status = data?.status;

    if (status === 'ready' || status === 'running') {
      onProgress?.({ status: 'ready', progress: 100, message: 'Connected' });
      return data as SandboxInfo;
    }
    if (status === 'error') {
      throw new Error(data?.message || 'Local sandbox creation failed');
    }

    // Report progress from backend or estimate
    const pct = data?.progress ?? Math.min(Math.round((i / 180) * 95), 95);
    const msg = data?.message || (i < 10 ? 'Pulling sandbox image...' : 'Setting up sandbox...');
    onProgress?.({ status: status || 'pulling', progress: pct, message: msg });
  }
  throw new Error('Timed out while pulling sandbox image');
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

export async function triggerSandboxUpdate(version: string): Promise<void> {
  await platformFetch<void>('/platform/sandbox/update', {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}

export async function getSandboxUpdateStatus(): Promise<SandboxUpdateStatus> {
  const result = await platformFetch<SandboxUpdateStatus>('/platform/sandbox/update/status', {
    method: 'GET',
  });
  if (result.data) return result.data;
  return result as unknown as SandboxUpdateStatus;
}

export async function resetSandboxUpdateStatus(): Promise<void> {
  await platformFetch<void>('/platform/sandbox/update/reset', {
    method: 'POST',
  });
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
  const result = await platformFetch<SSHSetupResult>('/platform/sandbox/ssh/setup', {
    method: 'POST',
  });
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to setup SSH');
  }
  return result.data;
}

export async function getSSHConnection(): Promise<SSHConnectionInfo> {
  const result = await platformFetch<SSHConnectionInfo>('/platform/sandbox/ssh/connection', {
    method: 'GET',
  });
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to resolve SSH connection');
  }
  return result.data;
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
