/**
 * Platform API client — shared, non-exported helpers.
 *
 * These are internal to the platform-client module group. They are exported so
 * sibling modules can use them, but they are intentionally NOT re-exported from
 * the barrel index.ts, so the public surface stays unchanged.
 */

import { authenticatedFetch } from '../auth';
import { platformConfig } from '../config';
import {
  listProjectSessions,
  listProjects,
  type KortixProject,
  type ProjectSession,
  type ProjectSessionSandbox,
} from '../projects-client';
import { SANDBOX_PORTS, type SandboxInfo, type SandboxProviderName } from './types';

/**
 * Get the base URL for platform API calls.
 *
 * Uses NEXT_PUBLIC_BACKEND_URL directly (includes /v1).
 */
export function getPlatformUrl(): string {
  // Server-side: prefer BACKEND_URL (internal Docker hostname) over
  // NEXT_PUBLIC_BACKEND_URL (browser-facing localhost, unreachable from container)
  const backendUrl = process.env.BACKEND_URL || platformConfig().backendUrl;
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

export function normalizeSandboxId(value: unknown): string | undefined {
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

export interface PlatformResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  created?: boolean;
}

export interface LocalBridgeSandboxResponse {
  success: boolean;
  status?: string;
  data?: SandboxInfo | null;
}

export const LOCAL_PLATFORM_CANDIDATES = [
  'http://localhost:8008/v1',
  'http://127.0.0.1:8008/v1',
];

export function getLocalBridgeStatusUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/platform/local-bridge/status`;
}

function normalizeSessionStatus(status: string | undefined): string {
  if (status === 'running' || status === 'active') return 'active';
  if (status === 'queued' || status === 'branching' || status === 'provisioning') return 'provisioning';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'stopped' || status === 'completed' || status === 'archived') return 'stopped';
  return status || 'unknown';
}

export function projectSessionToSandboxInfo(
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

export async function listProjectSessionSandboxes(): Promise<Array<{
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
      // Derive runtime info from the session row — do NOT call /start here, or
      // listing would wake every sandbox across every project. The single-session
      // open/create paths below use /start; a passive list must not.
      const runtime = null;
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

export async function findProjectSessionSandbox(sandboxId?: string): Promise<{
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

export async function platformFetch<T>(
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
