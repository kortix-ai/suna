/**
 * Platform API client.
 *
 * Routes through kortix-api (the unified backend) for sandbox lifecycle:
 *   GET  /platform/providers          — available sandbox providers
 *   POST /platform/init               — ensure user has a sandbox, provision if needed
 *   GET  /platform/sandbox            — get user's active sandbox
 *   GET  /platform/sandbox/list        — list all sandboxes
 *   POST /platform/sandbox/stop       — stop the active sandbox
 *   POST /platform/sandbox/restart    — restart the active sandbox
 *
 * In production: https://api.kortix.com/v1/platform/*  (base URL includes /v1)
 * In local:      http://localhost:8008/v1/platform/*  (base URL includes /v1)
 */

import { authenticatedFetch } from '@/lib/auth-token';
import { backendApi } from '@/lib/api-client';
import { getEnv } from '@/lib/env-config';
import type { ServerEntry } from '@/stores/server-store';

// ─── Sandbox Port Constants ──────────────────────────────────────────────────

/**
 * Well-known container ports exposed by the sandbox image.
 * These are the ports INSIDE the container — Docker maps them to random host ports.
 */
export const SANDBOX_PORTS = {
  DESKTOP: '6080',
  DESKTOP_HTTPS: '6081',
  PRESENTATION_VIEWER: '3210',
  STATIC_FILE_SERVER: '3211',
  KORTIX_MASTER: '8000',
  BROWSER_STREAM: '9223',
  BROWSER_VIEWER: '9224',
  SSH: '22',
} as const;

/**
 * Get a URL to access a specific container port on a sandbox.
 * ALL modes route through the backend's unified preview proxy:
 *   {BACKEND_URL}/p/{sandboxId}/{containerPort}
 *
 * Provider-agnostic — sandboxId is the external_id (container name for local,
 * Daytona sandbox ID for cloud).
 */
export function getDirectPortUrl(
  server: ServerEntry,
  containerPort: string,
): string | null {
  if (server.sandboxId && server.sandboxId !== 'undefined') {
    return `${getPlatformUrl()}/p/${server.sandboxId}/${containerPort}`;
  }
  return null;
}

/**
 * Get the base URL for platform API calls.
 *
 * Uses NEXT_PUBLIC_BACKEND_URL directly (includes /v1).
 */
function getPlatformUrl(): string {
  // Server-side: prefer BACKEND_URL (internal Docker hostname) over
  // NEXT_PUBLIC_BACKEND_URL (browser-facing localhost, unreachable from container)
  const backendUrl = process.env.BACKEND_URL || getEnv().BACKEND_URL;
  if (backendUrl) {
    return backendUrl;
  }

  // Fallback for local dev
  return 'http://localhost:8008/v1';
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type SandboxProviderName = 'daytona' | 'local_docker' | 'justavps';
export type ServerTypeOption = string;

export interface SandboxCreateProgress {
  status: 'pulling';
  progress: number;
  message: string;
}

export interface SandboxInfo {
  sandbox_id: string;
  external_id: string;
  name: string;
  provider: SandboxProviderName;
  base_url: string;
  status: string;
  version?: string | null;
  metadata?: Record<string, unknown>;
  is_included?: boolean;
  stripe_subscription_id?: string | null;
  stripe_subscription_item_id?: string | null;
  cancel_at_period_end?: boolean;
  cancel_at?: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeSandboxId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeSandboxId(item);
      if (normalized) return normalized;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeSandboxId(record.sandboxId ?? record.id ?? record.slug ?? Object.values(record)[0]);
  }
  return undefined;
}

export interface ProvidersInfo {
  providers: SandboxProviderName[];
  default: SandboxProviderName;
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

const LOCAL_PLATFORM_CANDIDATES = [
  'http://localhost:8008/v1',
  'http://127.0.0.1:8008/v1',
];

function getLocalBridgeStatusUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/platform/local-bridge/status`;
}

// ─── Fetch helper ────────────────────────────────────────────────────────────

async function platformFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<PlatformResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };

  const res = await authenticatedFetch(`${getPlatformUrl()}${path}`, {
    ...options,
    headers,
  });

  const body = await res.json();

  if (!res.ok) {
    throw new Error(body?.error || body?.message || `Platform API error ${res.status}`);
  }

  return body as PlatformResponse<T>;
}

// ─── API methods ─────────────────────────────────────────────────────────────

/**
 * Build the OpenCode server URL for a sandbox.
 * Provider-agnostic: {BACKEND_URL}/p/{externalId}/8000
 *
 * The external_id is the sandbox identifier used for routing:
 *   - Local Docker: container name (e.g. 'kortix-sandbox') — resolves via Docker DNS
 *   - Daytona (cloud): Daytona sandbox ID
 *
 * Guards against missing external_id to prevent broken URLs.
 */
export function getSandboxUrl(sandbox: SandboxInfo): string {
  if (!sandbox.external_id) {
    if (sandbox.base_url) return sandbox.base_url;
    throw new Error(
      `Cannot build sandbox URL: missing external_id for ${sandbox.provider} sandbox "${sandbox.sandbox_id}"`,
    );
  }

  return `${getPlatformUrl()}/p/${sandbox.external_id}/${SANDBOX_PORTS.KORTIX_MASTER}`;
}

/**
 * Build a URL to access a specific container port on a sandbox.
 * Provider-agnostic: {BACKEND_URL}/p/{externalId}/{containerPort}
 */
export function getSandboxPortUrl(
  sandbox: SandboxInfo,
  containerPort: string,
): string | null {
  if (sandbox.external_id) {
    return `${getPlatformUrl()}/p/${sandbox.external_id}/${containerPort}`;
  }
  return null;
}

/**
 * Extract mappedPorts from sandbox metadata (convenience for storing in ServerEntry).
 * Returns undefined if not available.
 */
export function extractMappedPorts(
  sandbox: SandboxInfo,
): Record<string, string> | undefined {
  if (sandbox.provider !== 'local_docker') return undefined;
  const ports = sandbox.metadata?.mappedPorts;
  if (ports && typeof ports === 'object' && !Array.isArray(ports)) {
    return ports as Record<string, string>;
  }
  return undefined;
}

/**
 * Get available sandbox providers from the platform service.
 */
export async function getProviders(): Promise<ProvidersInfo> {
  const result = await platformFetch<ProvidersInfo>('/platform/providers');
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to get providers');
  }
  return result.data;
}

/**
 * Ensure a sandbox is running. Idempotent:
 *   - Running  → return it
 *   - Stopped  → start it
 *   - Missing  → create it
 */
export async function ensureSandbox(opts?: {
  provider?: SandboxProviderName;
  serverType?: ServerTypeOption;
}): Promise<{ sandbox: SandboxInfo; created: boolean }> {
  const result = await platformFetch<SandboxInfo>('/platform/init', {
    method: 'POST',
    body: opts
      ? JSON.stringify({
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.serverType ? { serverType: opts.serverType } : {}),
        })
      : undefined,
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to ensure sandbox');
  }

  return { sandbox: result.data, created: result.created ?? false };
}

/**
 * Get the user's sandbox.
 * Returns null if no sandbox exists (call ensureSandbox first).
 */
export async function getSandbox(): Promise<SandboxInfo | null> {
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
 * Create a brand new sandbox. Unlike ensureSandbox(), this always provisions
 * a fresh one — it does NOT return an existing sandbox.
 *
 * Use this when the user explicitly clicks "Cloud" or "Local Docker" in the
 * Instance Manager. For idempotent "make sure I have a sandbox" logic, use
 * ensureSandbox() instead.
 */
export async function createSandbox(opts?: {
  provider?: SandboxProviderName;
  serverType?: ServerTypeOption;
  name?: string;
  onProgress?: (progress: SandboxCreateProgress) => void;
}): Promise<{ sandbox: SandboxInfo }> {
  if (opts?.provider === 'local_docker') {
    const headers = {
      'Content-Type': 'application/json',
    };

    const initRes = await authenticatedFetch(`${getPlatformUrl()}/platform/init/local`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(opts?.name ? { name: opts.name } : {}),
      }),
    });

    const initData = await initRes.json();
    if (!initRes.ok) {
      throw new Error(initData?.error || initData?.message || `Platform API error ${initRes.status}`);
    }

    if (initData.status === 'ready' && initData.data) {
      return { sandbox: initData.data as SandboxInfo };
    }

    if (initData.status === 'error') {
      throw new Error(initData.message || initData.error || 'Failed to create sandbox');
    }

    if (initData.status === 'pulling') {
      const reportProgress = (data: { progress?: number; message?: string }) => {
        opts?.onProgress?.({
          status: 'pulling',
          progress: Math.max(0, Math.min(100, Number(data.progress) || 0)),
          message: data.message || 'Pulling sandbox image...',
        });
      };

      reportProgress(initData);

      for (let attempt = 0; attempt < 360; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const statusRes = await authenticatedFetch(`${getPlatformUrl()}/platform/init/local/status`, {
          method: 'GET',
        });
        const statusData = await statusRes.json();

        if (!statusRes.ok) {
          throw new Error(statusData?.error || statusData?.message || `Platform API error ${statusRes.status}`);
        }

        if (statusData.status === 'ready' && statusData.data) {
          return { sandbox: statusData.data as SandboxInfo };
        }

        if (statusData.status === 'error') {
          throw new Error(statusData.message || statusData.error || 'Failed to create sandbox');
        }

        reportProgress(statusData);
      }

      throw new Error('Timed out while pulling sandbox image');
    }

    if (initData.success && initData.data) {
      return { sandbox: initData.data as SandboxInfo };
    }

    throw new Error(initData.error || initData.message || 'Failed to create sandbox');
  }

  const result = await platformFetch<SandboxInfo>('/platform/sandbox', {
    method: 'POST',
    body: JSON.stringify({
      ...(opts?.provider ? { provider: opts.provider } : {}),
      ...(opts?.serverType ? { serverType: opts.serverType } : {}),
      ...(opts?.name ? { name: opts.name } : {}),
    }),
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to create sandbox');
  }

  return { sandbox: result.data };
}

/**
 * Get a single sandbox by ID from the list.
 * Avoids fetching the full list when only one sandbox is needed.
 */
export async function getSandboxById(sandboxId: unknown): Promise<SandboxInfo | null> {
  const normalizedSandboxId = normalizeSandboxId(sandboxId);
  if (!normalizedSandboxId) return null;

  const all = await listSandboxes(normalizedSandboxId);
  const ownMatch = all.find((s) => s.sandbox_id === normalizedSandboxId) ?? null;
  if (ownMatch) return ownMatch;

  try {
    // Admin-scoped fallback — if the user isn't admin, the 403 is expected
    // for non-owners. Suppress the automatic error toast/log so the
    // instance-detail page doesn't scream about an expected 403 just
    // because the sandbox isn't in the caller's own listing.
    const response = await backendApi.get<{
      sandbox: {
        sandboxId: string;
        externalId: string | null;
        name: string | null;
        provider: SandboxProviderName | null;
        baseUrl: string | null;
        status: string | null;
        metadata: unknown;
        createdAt: string;
        updatedAt: string;
      };
    }>(`/admin/api/sandboxes/${normalizedSandboxId}`, { showErrors: false });

    const row = response.data?.sandbox;
    if (!row) return null;

    return {
      sandbox_id: row.sandboxId,
      external_id: row.externalId || '',
      name: row.name || row.sandboxId,
      provider: (row.provider || 'justavps') as SandboxProviderName,
      base_url: row.baseUrl || '',
      status: row.status || 'unknown',
      metadata: (row.metadata as Record<string, unknown> | undefined) ?? undefined,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * List all sandboxes for the user's account.
 */
export async function listSandboxes(sandboxId?: unknown): Promise<SandboxInfo[]> {
  const normalizedSandboxId = normalizeSandboxId(sandboxId);

  try {
    const qs = normalizedSandboxId ? `?sandbox_id=${encodeURIComponent(normalizedSandboxId)}` : '';
    const result = await platformFetch<SandboxInfo[]>(`/platform/sandbox/list${qs}`, {
      method: 'GET',
    });

    const rows = result.success && result.data ? result.data : [];
    const discoveredLocal = await discoverLocalSandbox();
    if (!discoveredLocal) return rows;
    if (normalizedSandboxId && discoveredLocal.sandbox_id !== normalizedSandboxId) {
      return rows;
    }

    const withoutDuplicate = rows.filter((sandbox) => sandbox.sandbox_id !== discoveredLocal.sandbox_id);
    return [discoveredLocal, ...withoutDuplicate];
  } catch {
    const discoveredLocal = await discoverLocalSandbox().catch(() => null);
    if (!discoveredLocal) return [];
    if (normalizedSandboxId && discoveredLocal.sandbox_id !== normalizedSandboxId) {
      return [];
    }
    return [discoveredLocal];
  }
}

export async function discoverLocalSandbox(): Promise<SandboxInfo | null> {
  if (typeof window === 'undefined') return null;

  const currentPlatformUrl = getPlatformUrl();
  const candidateBases = Array.from(new Set([currentPlatformUrl, ...LOCAL_PLATFORM_CANDIDATES]));

  for (const baseUrl of candidateBases) {
    try {
      const response = await fetch(getLocalBridgeStatusUrl(baseUrl), {
        method: 'GET',
        signal: AbortSignal.timeout(1500),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        continue;
      }

      const bridgeStatus = await response.json() as LocalBridgeSandboxResponse;

      if (!bridgeStatus.success || bridgeStatus.status !== 'ready' || !bridgeStatus.data?.sandbox_id) {
        continue;
      }

      return bridgeStatus.data;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Restart a sandbox workload. For JustAVPS this repairs the managed workload
 * container/service and only starts the host if it is currently stopped.
 */
export async function restartSandbox(sandboxId?: string): Promise<void> {
  if (!sandboxId) {
    throw new Error('No sandbox selected for workload restart');
  }
  try {
    const result = await platformFetch<void>('/platform/sandbox/restart', {
      method: 'POST',
      body: JSON.stringify({ sandbox_id: sandboxId }),
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to restart sandbox');
    }
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/No sandbox to restart/i.test(message)) {
      throw error;
    }

    const adminFallback = await backendApi.post(`/admin/api/sandboxes/${sandboxId}/repair`, { action: 'restart_workload' }, {
      showErrors: false,
    });
    if (adminFallback.success) {
      return;
    }

    throw error;
  }
}

/**
 * Stop a sandbox. Pass `sandboxId` to target a specific instance; omit to
 * stop the user's active sandbox.
 */
export async function stopSandbox(sandboxId?: string): Promise<void> {
  const result = await platformFetch<void>('/platform/sandbox/stop', {
    method: 'POST',
    body: sandboxId ? JSON.stringify({ sandbox_id: sandboxId }) : undefined,
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to stop sandbox');
  }
}

/**
 * Schedule a sandbox for cancellation at end of billing period.
 * The instance keeps running until then; reactivate to reverse.
 */
export async function cancelSandbox(sandboxId?: string): Promise<{ cancel_at: string | null }> {
  const result = await platformFetch<{ cancel_at: string | null }>('/platform/sandbox/cancel', {
    method: 'POST',
    body: sandboxId ? JSON.stringify({ sandbox_id: sandboxId }) : undefined,
  });
  if (!result.success) {
    throw new Error(result.error || 'Failed to schedule cancellation');
  }
  return (result.data as { cancel_at: string | null }) ?? { cancel_at: null };
}

/**
 * Reverse a scheduled cancellation — subscription continues as normal.
 */
export async function reactivateSandbox(sandboxId?: string): Promise<void> {
  const result = await platformFetch<void>('/platform/sandbox/reactivate', {
    method: 'POST',
    body: sandboxId ? JSON.stringify({ sandbox_id: sandboxId }) : undefined,
  });
  if (!result.success) {
    throw new Error(result.error || 'Failed to reactivate sandbox');
  }
}

// ─── Backup API ─────────────────────────────────────────────────────────────

export interface BackupInfo {
  id: string;
  description: string;
  created: string;
  size: number;
  status: string;
}

export interface BackupListResponse {
  backups: BackupInfo[];
  backups_enabled: boolean;
}

export async function listBackups(sandboxId: string): Promise<BackupListResponse> {
  const result = await platformFetch<BackupListResponse>(
    `/platform/sandbox/${sandboxId}/backups`,
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to list backups');
  }
  return result.data;
}

export async function createBackup(
  sandboxId: string,
  description?: string,
): Promise<{ backup_id: string; status: string }> {
  const result = await platformFetch<{ backup_id: string; status: string }>(
    `/platform/sandbox/${sandboxId}/backups`,
    {
      method: 'POST',
      body: description ? JSON.stringify({ description }) : undefined,
    },
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to create backup');
  }
  return result.data;
}

export async function restoreBackup(
  sandboxId: string,
  backupId: string,
): Promise<void> {
  const result = await platformFetch<{ action: string; status: string }>(
    `/platform/sandbox/${sandboxId}/backups/${backupId}/restore`,
    { method: 'POST' },
  );
  if (!result.success) {
    throw new Error(result.error || 'Failed to restore backup');
  }
}

export async function deleteBackup(
  sandboxId: string,
  backupId: string,
): Promise<void> {
  const result = await platformFetch<{ action: string; status: string }>(
    `/platform/sandbox/${sandboxId}/backups/${backupId}`,
    { method: 'DELETE' },
  );
  if (!result.success) {
    throw new Error(result.error || 'Failed to delete backup');
  }
}

// ─── SSH Setup API ──────────────────────────────────────────────────────────

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

/**
 * Generate an SSH keypair and inject it into the active sandbox.
 * Returns the private key and connection details for VS Code Remote SSH.
 */
export async function setupSSH(sandboxId?: string): Promise<SSHSetupResult> {
  const result = await platformFetch<SSHSetupResult>('/platform/sandbox/ssh/setup', {
    method: 'POST',
    body: JSON.stringify(sandboxId ? { sandboxId } : {}),
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to setup SSH');
  }

  return result.data;
}

export async function getSSHConnection(sandboxId?: string): Promise<SSHConnectionInfo> {
  const qs = sandboxId ? `?sandboxId=${encodeURIComponent(sandboxId)}` : '';
  const result = await platformFetch<SSHConnectionInfo>(`/platform/sandbox/ssh/connection${qs}`, {
    method: 'GET',
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to resolve SSH connection');
  }

  return result.data;
}

// ─── Sandbox Update API ─────────────────────────────────────────────────────

export interface ChangelogChange {
  type: 'feature' | 'fix' | 'improvement' | 'breaking' | 'upstream' | 'security' | 'deprecation';
  text: string;
}

export interface ChangelogArtifact {
  name: string;
  target: 'npm' | 'docker-hub' | 'github-release' | 'daytona';
}

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  description: string;
  changes: ChangelogChange[];
  artifacts?: ChangelogArtifact[];
  /** Present on dev changelog entries */
  channel?: 'stable' | 'dev';
  sha?: string;
  author?: string;
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

export interface SandboxVersionInfo {
  version: string;
  channel?: string;
  date?: string;
  sha?: string;
  changelog: ChangelogEntry | null;
}

export interface SandboxUpdateResult {
  success?: boolean;
  upToDate?: boolean;
  previousVersion?: string;
  currentVersion: string;
  changelog?: ChangelogEntry | null;
  output?: string;
  error?: string;
}

/**
 * Update phases — Docker image-based flow.
 *
 * JustAVPS: backing_up → pulling → patching → stopping → restarting → verifying → complete
 * Local:    pulling → stopping → removing → recreating → health_check → complete
 */
export type UpdatePhase =
  | 'idle'
  | 'backing_up'
  | 'pulling'
  | 'patching'
  | 'stopping'
  | 'removing'
  | 'recreating'
  | 'restarting'
  | 'verifying'
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
  /** Provider-side backup ID while phase === 'backing_up'. Null otherwise. */
  backupId?: string | null;
  cancelRequested?: boolean;
  diagnostics?: Record<string, string | number | boolean | null>;
}

/** Phases where the sandbox is being modified and must not be used. */
export const DESTRUCTIVE_PHASES: UpdatePhase[] = [
  'pulling', 'patching', 'stopping', 'removing', 'recreating',
  'restarting', 'verifying', 'starting', 'health_check',
];

export function isDestructivePhase(phase: UpdatePhase): boolean {
  return DESTRUCTIVE_PHASES.includes(phase);
}

/**
 * Get the current update status from kortix-api.
 * The API tracks the Docker pull + recreate progress.
 */
export async function getSandboxUpdateStatus(
  sandbox?: SandboxInfo,
): Promise<SandboxUpdateStatus> {
  const url = sandbox?.sandbox_id
    ? `${getPlatformUrl()}/platform/sandbox/${sandbox.sandbox_id}/update/status`
    : `${getPlatformUrl()}/platform/sandbox/update/status`;
  const res = await authenticatedFetch(url, {
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
  return res.json();
}

/**
 * Get the latest available sandbox version — proxied through the platform API.
 * Uses GitHub Releases API for stable, GitHub Commits API for dev.
 *
 * @param channel — 'stable' (default) or 'dev'
 */
export async function getLatestSandboxVersion(channel?: VersionChannel): Promise<SandboxVersionInfo> {
  const params = channel ? `?channel=${channel}` : '';
  const res = await fetch(`${getPlatformUrl()}/platform/sandbox/version/latest${params}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Version check failed: ${res.status}`);
  const latest = await res.json() as SandboxVersionInfo & { title?: string };

  try {
    const changelogEntries = await getFullChangelog(channel || 'stable');
    latest.changelog = changelogEntries.find((entry) => entry.version === latest.version) ?? changelogEntries[0] ?? null;
  } catch {
    latest.changelog = null;
  }

  return latest;
}

/**
 * Get the full changelog from the platform.
 * Supports channel filtering: 'stable', 'dev', or 'all' (default).
 */
export async function getFullChangelog(channel?: 'stable' | 'dev' | 'all'): Promise<ChangelogEntry[]> {
  const params = channel ? `?channel=${channel}` : '';
  const res = await fetch(`${getPlatformUrl()}/platform/sandbox/version/changelog${params}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Changelog fetch failed: ${res.status}`);
  const data = await res.json();
  return data.changelog;
}

/**
 * Get all available versions (both stable and dev).
 */
export async function getAllVersions(): Promise<AllVersionsResponse> {
  const res = await fetch(`${getPlatformUrl()}/platform/sandbox/version/all`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`All versions fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Trigger a Docker image-based sandbox update via kortix-api.
 *
 * The API pulls the new image, stops the container, removes it (preserving
 * the /workspace volume), and recreates with the new image. The frontend
 * should poll getSandboxUpdateStatus() for progress.
 */
export async function triggerSandboxUpdate(
  sandbox: SandboxInfo,
  version: string,
): Promise<SandboxUpdateResult> {
  // Use per-sandbox route for cloud sandboxes, legacy route for local_docker
  const url = sandbox.sandbox_id
    ? `${getPlatformUrl()}/platform/sandbox/${sandbox.sandbox_id}/update`
    : `${getPlatformUrl()}/platform/sandbox/update`;
  const res = await authenticatedFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Update failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Reset the update status on kortix-api (e.g. after a failed update to allow retry).
 */
export async function resetSandboxUpdateStatus(sandbox?: SandboxInfo): Promise<void> {
  const url = sandbox?.sandbox_id
    ? `${getPlatformUrl()}/platform/sandbox/${sandbox.sandbox_id}/update/reset`
    : `${getPlatformUrl()}/platform/sandbox/update/reset`;
  const res = await authenticatedFetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}

export async function cancelSandboxUpdate(sandbox?: SandboxInfo): Promise<void> {
  const url = sandbox?.sandbox_id
    ? `${getPlatformUrl()}/platform/sandbox/${sandbox.sandbox_id}/update/cancel`
    : `${getPlatformUrl()}/platform/sandbox/update/cancel`;
  const res = await authenticatedFetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Cancel failed: ${res.status}`);
  }
}
