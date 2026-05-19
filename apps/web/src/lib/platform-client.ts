/**
 * Platform API client.
 *
 * The legacy account-level sandbox lifecycle API was removed. This adapter
 * keeps older instance UI call sites pointed at the supported project-session
 * endpoints under /projects/:projectId/sessions/:sessionId.
 */

import { authenticatedFetch } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import type { ServerEntry } from '@/stores/server-store';
import {
  createProjectSession,
  deleteProjectSession,
  getProjectSessionSandbox,
  listProjectSessions,
  listProjects,
  restartProjectSession,
  type KortixProject,
  type ProjectSession,
  type ProjectSessionSandbox,
} from '@/lib/projects-client';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDbSandboxId(sandboxId: string | null | undefined): sandboxId is string {
  return !!sandboxId && UUID_RE.test(sandboxId);
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
  lifecycle_status?: string;
  init_status?: 'pending' | 'provisioning' | 'retrying' | 'ready' | 'failed';
  health_status?: 'healthy' | 'degraded' | 'offline' | 'unknown';
  init_attempts?: number;
  last_init_error?: string | null;
  version?: string | null;
  metadata?: Record<string, unknown>;
  is_included?: boolean;
  stripe_subscription_id?: string | null;
  stripe_subscription_item_id?: string | null;
  cancel_at_period_end?: boolean;
  cancel_at?: string | null;
  auto_update_enabled?: boolean;
  auto_update_channel?: 'stable' | 'dev';
  auto_update?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** True when the current viewer is the account owner (or a platform admin) — gates rename/manage UI. */
  can_manage?: boolean;
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

function normalizeSessionStatus(status: string | undefined): string {
  if (status === 'running' || status === 'active') return 'active';
  if (status === 'queued' || status === 'branching' || status === 'provisioning') return 'provisioning';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'stopped' || status === 'completed' || status === 'archived') return 'stopped';
  return status || 'unknown';
}

function projectSessionToSandboxInfo(
  project: KortixProject,
  session: ProjectSession,
  runtime?: ProjectSessionSandbox | null,
): SandboxInfo {
  const externalId = runtime?.external_id || session.sandbox_url?.match(/\/p\/([^/]+)\//)?.[1] || session.sandbox_id;
  return {
    sandbox_id: runtime?.sandbox_id || session.sandbox_id || session.session_id,
    external_id: externalId,
    name: session.name || `${project.name} session`,
    provider: runtime?.provider || (session.sandbox_provider as SandboxProviderName | null) || 'daytona',
    base_url: runtime?.base_url || session.sandbox_url || (runtime?.external_id ? `${getPlatformUrl()}/p/${runtime.external_id}/${SANDBOX_PORTS.KORTIX_MASTER}` : ''),
    status: normalizeSessionStatus(runtime?.status || session.status),
    metadata: {
      ...(session.metadata ?? {}),
      project_id: project.project_id,
      session_id: session.session_id,
      project_name: project.name,
      runtime_status: runtime?.status,
      error: session.error,
    },
    created_at: runtime?.created_at || session.created_at,
    updated_at: runtime?.updated_at || session.updated_at,
  };
}

async function listProjectSessionSandboxes(): Promise<Array<{
  project: KortixProject;
  session: ProjectSession;
  runtime: ProjectSessionSandbox | null;
  sandbox: SandboxInfo;
}>> {
  const projects = await listProjects();
  const rows: Array<{
    project: KortixProject;
    session: ProjectSession;
    runtime: ProjectSessionSandbox | null;
    sandbox: SandboxInfo;
  }> = [];

  for (const project of projects) {
    const sessions = await listProjectSessions(project.project_id).catch(() => []);
    for (const session of sessions) {
      const runtime = await getProjectSessionSandbox(project.project_id, session.session_id);
      rows.push({
        project,
        session,
        runtime,
        sandbox: projectSessionToSandboxInfo(project, session, runtime),
      });
    }
  }

  return rows.sort((a, b) => {
    const priority: Record<string, number> = { active: 0, provisioning: 1, stopped: 2, error: 3 };
    const statusDelta = (priority[a.sandbox.status] ?? 99) - (priority[b.sandbox.status] ?? 99);
    if (statusDelta !== 0) return statusDelta;
    return Date.parse(b.sandbox.updated_at) - Date.parse(a.sandbox.updated_at);
  });
}

async function findProjectSessionSandbox(sandboxId?: string): Promise<{
  project: KortixProject;
  session: ProjectSession;
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
  return { providers: ['daytona'], default: 'daytona' };
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
  const existing = await findProjectSessionSandbox();
  if (existing) return { sandbox: existing.sandbox, created: false };

  const projects = await listProjects();
  const project = projects[0];
  if (!project) {
    throw new Error('Create a project before starting a sandbox');
  }

  const session = await createProjectSession(project.project_id, {
    ...(opts?.provider ? { agent_name: opts.provider } : {}),
  });
  const runtime = await getProjectSessionSandbox(project.project_id, session.session_id);
  return { sandbox: projectSessionToSandboxInfo(project, session, runtime), created: true };
}

/**
 * Get the user's sandbox.
 * Returns null if no sandbox exists (call ensureSandbox first).
 */
export async function getSandbox(): Promise<SandboxInfo | null> {
  const row = await findProjectSessionSandbox().catch(() => null);
  return row?.sandbox ?? null;
}

/**
 * Create a brand new remote sandbox. For local Docker this adopts an already
 * running manual sandbox; it never starts, pulls, or creates a container.
 *
 * Use this when the user explicitly clicks a provider in the Instance Manager.
 * For idempotent "make sure I have a sandbox" logic, use ensureSandbox() instead.
 */
export async function createSandbox(opts?: {
  provider?: SandboxProviderName;
  serverType?: ServerTypeOption;
  name?: string;
}): Promise<{ sandbox: SandboxInfo }> {
  if (opts?.provider === 'local_docker') {
    throw new Error('Local Docker instances are not exposed by the current project-session API');
  }

  const result = await ensureSandbox(opts);
  return { sandbox: result.sandbox };
}

/**
 * Get a single sandbox by ID from the list.
 * Avoids fetching the full list when only one sandbox is needed.
 */
export async function getSandboxById(sandboxId: unknown): Promise<SandboxInfo | null> {
  const normalizedSandboxId = normalizeSandboxId(sandboxId);
  if (!normalizedSandboxId) return null;

  const row = await findProjectSessionSandbox(normalizedSandboxId).catch(() => null);
  return row?.sandbox ?? null;
}

export async function renameSandbox(sandboxId: string, _name: string): Promise<SandboxInfo> {
  const row = await findProjectSessionSandbox(sandboxId);
  if (!row) throw new Error('Project session sandbox not found');
  throw new Error('Renaming project-session sandboxes is not exposed by the current API');
}

// ─── Sandbox members (team access) ───────────────────────────────────────────

export type SandboxMemberRole = 'owner' | 'admin' | 'member';

export interface SandboxMember {
  user_id: string;
  email: string | null;
  role: SandboxMemberRole | null;
  added_by: string | null;
  added_at: string;
  monthly_spend_cap_cents?: number | null;
  current_period_cents?: number;
}

export interface SandboxPendingInvite {
  invite_id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string | null;
  created_at: string;
  expires_at: string;
}

export interface SandboxMembersResponse {
  sandbox_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: SandboxMember[];
  pending_invites: SandboxPendingInvite[];
}

export interface AddSandboxMemberResult {
  status: 'added' | 'invited';
  user_id?: string;
  email?: string;
  role?: 'admin' | 'member';
}

export async function listSandboxMembers(sandboxId: string): Promise<SandboxMembersResponse> {
  throw new Error('Sandbox members moved to project access; use project members for project-session sandboxes');
}

export async function addSandboxMember(
  sandboxId: string,
  email: string,
  role: 'admin' | 'member' = 'member',
): Promise<AddSandboxMemberResult> {
  throw new Error('Sandbox members moved to project access; invite the user to the project instead');
}

export async function removeSandboxMember(sandboxId: string, userId: string): Promise<void> {
  throw new Error('Sandbox members moved to project access; update project access instead');
}

export async function updateSandboxMemberRole(
  sandboxId: string,
  userId: string,
  role: SandboxMemberRole,
): Promise<void> {
  throw new Error('Sandbox members moved to project access; update project access instead');
}

export async function updateSandboxMemberSpendCap(
  sandboxId: string,
  userId: string,
  capCents: number | null,
): Promise<void> {
  throw new Error('Sandbox member spend caps are not exposed for project-session sandboxes');
}

export type ScopeEffect = 'grant' | 'revoke' | null;

export interface SandboxScopeCatalogEntry {
  scope: string;
  label: string;
  description: string;
  group: string;
}

export interface SandboxMemberScopes {
  sandbox_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | null;
  inherited: string[];
  grants: string[];
  revokes: string[];
  effective: string[];
  catalog: SandboxScopeCatalogEntry[];
  groups: Record<string, string[]>;
}

export interface SandboxViewerScopes {
  sandbox_id: string;
  role: 'owner' | 'admin' | 'member' | null;
  scopes: string[];
}

export async function getViewerSandboxScopes(
  sandboxId: string,
): Promise<SandboxViewerScopes> {
  throw new Error('Sandbox scopes moved to project access for project-session sandboxes');
}

export async function getSandboxMemberScopes(
  sandboxId: string,
  userId: string,
): Promise<SandboxMemberScopes> {
  throw new Error('Sandbox scopes moved to project access for project-session sandboxes');
}

export async function updateSandboxMemberScope(
  sandboxId: string,
  userId: string,
  scope: string,
  effect: ScopeEffect,
): Promise<void> {
  throw new Error('Sandbox scopes moved to project access for project-session sandboxes');
}

// ─── Legacy project ACL inside a sandbox ─────────────────────────────────────
//
// The ACL lives in kortix-master's sqlite next to the projects it governs, so
// these helpers talk to kortix-master via the preview proxy. Emails aren't
// known inside the sandbox — hydrate them client-side by joining against the
// sandbox member list (which does carry emails).

export interface SandboxProjectMember {
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  added_by: string | null;
  added_at: string;
}

export interface SandboxProjectMembersResponse {
  project_id: string;
  members: SandboxProjectMember[];
}

async function fetchKortixMaster<T>(
  sandbox: SandboxInfo,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = getSandboxUrl(sandbox);
  const res = await authenticatedFetch(`${base.replace(/\/+$/, '')}${path}`, {
    signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function listSandboxProjectMembers(
  sandbox: SandboxInfo,
  projectId: string,
): Promise<SandboxProjectMembersResponse> {
  return fetchKortixMaster<SandboxProjectMembersResponse>(
    sandbox,
    `/kortix/projects/${encodeURIComponent(projectId)}/members`,
    { method: 'GET' },
  );
}

export async function grantSandboxProjectAccess(
  sandbox: SandboxInfo,
  projectId: string,
  userId: string,
  role: 'admin' | 'member' = 'member',
): Promise<void> {
  await fetchKortixMaster<void>(
    sandbox,
    `/kortix/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, role }),
    },
  );
}

export async function revokeSandboxProjectAccess(
  sandbox: SandboxInfo,
  projectId: string,
  userId: string,
): Promise<void> {
  await fetchKortixMaster<void>(
    sandbox,
    `/kortix/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

export async function revokeSandboxInvite(sandboxId: string, inviteId: string): Promise<void> {
  throw new Error('Sandbox invites moved to project access for project-session sandboxes');
}

// ─── Invite accept/decline ───────────────────────────────────────────────────

// Visible form — viewer is the intended recipient, so all details are returned.
export interface InviteDetailsVisible {
  invite_id: string;
  sandbox_id: string;
  sandbox_name: string | null;
  email: string;
  inviter_email: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  email_matches_caller: true;
  expired: boolean;
}

// Redacted form — viewer is signed in as someone else. We never leak which
// account or address an invite belongs to if the viewer isn't the recipient.
export interface InviteDetailsRedacted {
  invite_id: string;
  sandbox_id: null;
  sandbox_name: null;
  email: null;
  inviter_email: null;
  created_at: null;
  expires_at: null;
  accepted_at: string | null;
  email_matches_caller: false;
  expired: boolean;
}

export type InviteDetails = InviteDetailsVisible | InviteDetailsRedacted;

export async function getInvite(inviteId: string): Promise<InviteDetails> {
  const result = await platformFetch<InviteDetails>(
    `/platform/invites/${encodeURIComponent(inviteId)}`,
    { method: 'GET' },
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Invite not found');
  }
  return result.data;
}

export async function acceptInvite(inviteId: string): Promise<{ status: string; sandbox_id: string }> {
  const result = await platformFetch<{ status: string; sandbox_id: string }>(
    `/platform/invites/${encodeURIComponent(inviteId)}/accept`,
    { method: 'POST' },
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to accept invite');
  }
  return result.data;
}

export async function declineInvite(inviteId: string): Promise<void> {
  const result = await platformFetch<void>(
    `/platform/invites/${encodeURIComponent(inviteId)}/decline`,
    { method: 'POST' },
  );
  if (!result.success) {
    throw new Error(result.error || 'Failed to decline invite');
  }
}

/**
 * List all sandboxes for the user's account.
 */
export async function listSandboxes(sandboxId?: unknown): Promise<SandboxInfo[]> {
  const normalizedSandboxId = normalizeSandboxId(sandboxId);

  const rows = await listProjectSessionSandboxes().catch(() => []);
  return rows
    .map((row) => row.sandbox)
    .filter((sandbox) =>
      !normalizedSandboxId ||
      sandbox.sandbox_id === normalizedSandboxId ||
      sandbox.external_id === normalizedSandboxId
    );
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
  const row = await findProjectSessionSandbox(sandboxId);
  if (!row) throw new Error('Project session sandbox not found');
  await restartProjectSession(row.project.project_id, row.session.session_id);
}

/**
 * Stop a sandbox. Pass `sandboxId` to target a specific instance; omit to
 * stop the user's active sandbox.
 */
export async function stopSandbox(sandboxId?: string): Promise<void> {
  if (!sandboxId) throw new Error('No sandbox selected to stop');
  const row = await findProjectSessionSandbox(sandboxId);
  if (!row) throw new Error('Project session sandbox not found');
  await deleteProjectSession(row.project.project_id, row.session.session_id);
}

/**
 * Schedule a sandbox for cancellation at end of billing period.
 * The instance keeps running until then; reactivate to reverse.
 */
export async function cancelSandbox(sandboxId?: string): Promise<{ cancel_at: string | null }> {
  throw new Error('Cancellation is not exposed for project-session sandboxes');
}

/**
 * Reverse a scheduled cancellation — subscription continues as normal.
 */
export async function reactivateSandbox(sandboxId?: string): Promise<void> {
  throw new Error('Reactivation is not exposed for project-session sandboxes');
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
  throw new Error('Backups are not exposed for project-session sandboxes');
}

export async function createBackup(
  sandboxId: string,
  description?: string,
): Promise<{ backup_id: string; status: string }> {
  throw new Error('Backups are not exposed for project-session sandboxes');
}

export async function restoreBackup(
  sandboxId: string,
  backupId: string,
): Promise<void> {
  throw new Error('Backups are not exposed for project-session sandboxes');
}

export async function deleteBackup(
  sandboxId: string,
  backupId: string,
): Promise<void> {
  throw new Error('Backups are not exposed for project-session sandboxes');
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
  throw new Error('SSH setup is not exposed for project-session sandboxes');
}

export async function getSSHConnection(sandboxId?: string): Promise<SSHConnectionInfo> {
  throw new Error('SSH connection details are not exposed for project-session sandboxes');
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
 * Local Docker is manual-only and is not updated through the API.
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
  return {
    phase: 'idle',
    progress: 0,
    message: 'Sandbox image updates are managed by project-session provisioning.',
    targetVersion: null,
    previousVersion: null,
    currentVersion: sandbox?.version ?? null,
    error: null,
    startedAt: null,
    updatedAt: null,
  };
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
  throw new Error('Sandbox image updates are managed by project-session provisioning');
}

/**
 * Reset the update status on kortix-api (e.g. after a failed update to allow retry).
 */
export async function resetSandboxUpdateStatus(sandbox?: SandboxInfo): Promise<void> {
  return;
}

export async function cancelSandboxUpdate(sandbox?: SandboxInfo): Promise<void> {
  return;
}
