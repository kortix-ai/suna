/**
 * Platform API client — sandbox lifecycle (providers, ensure/get/create/list,
 * discovery, restart/stop, cancel/reactivate).
 */

import {
  createProjectSession,
  deleteProjectSession,
  startProjectSession,
  listProjects,
  restartProjectSession,
  stopProjectSession,
} from '../projects-client';
import type {
  SandboxInfo,
  SandboxProviderName,
  ServerTypeOption,
  ProvidersInfo,
} from './types';
import {
  findProjectSessionSandbox,
  listProjectSessionSandboxes,
  projectSessionToSandboxInfo,
  normalizeSandboxId,
  getPlatformUrl,
  getLocalBridgeStatusUrl,
  LOCAL_PLATFORM_CANDIDATES,
  type LocalBridgeSandboxResponse,
} from './shared';

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
  const runtime = (await startProjectSession(project.project_id, session.session_id))?.sandbox ?? null;
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
 * Stop a sandbox in place — pauses the running sandbox (disk kept, resumable
 * via restart/start) without deleting the session. Pass `sandboxId` to target
 * a specific instance; omit to stop the user's active sandbox.
 *
 * Previously this called deleteProjectSession, which destroys the session
 * instead of pausing it — fixed to use the dedicated stop endpoint.
 */
export async function stopSandbox(sandboxId?: string): Promise<void> {
  if (!sandboxId) throw new Error('No sandbox selected to stop');
  const row = await findProjectSessionSandbox(sandboxId);
  if (!row) throw new Error('Project session sandbox not found');
  await stopProjectSession(row.project.project_id, row.session.session_id);
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
