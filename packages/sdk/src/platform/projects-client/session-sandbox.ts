// Session sandbox — runtime sandbox row + the session-open (/start) flow.

import type { QueryClient } from '@tanstack/react-query';

import { backendApi } from '../api-client';

// ---------------------------------------------------------------------------
// Session sandbox — runtime row in `kortix.session_sandboxes`. Separate from
// the legacy /instances sandbox table (`kortix.sandboxes`); no billing or
// team-membership coupling. Access gated by `project_members` only.
// ---------------------------------------------------------------------------

export type ProjectSessionSandboxStatus =
  | 'provisioning'
  | 'active'
  | 'stopped'
  | 'error'
  | 'archived';

export interface ProjectSessionSandbox {
  sandbox_id: string;
  session_id: string;
  project_id: string;
  account_id: string;
  provider: 'daytona' | 'local_docker' | 'justavps';
  external_id: string | null;
  base_url: string | null;
  status: ProjectSessionSandboxStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SessionStartStage = 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';

export interface SessionStartResult {
  /** Coarse lifecycle stage to render + poll on. */
  stage: SessionStartStage;
  /** Whether polling /start again can make progress (false = terminal). */
  retriable: boolean;
  sandbox: ProjectSessionSandbox | null;
  opencode_session_id: string | null;
  reason?: string;
}

/**
 * THE session-open call. Idempotently provisions/resumes the sandbox and resolves
 * the OpenCode pin server-side, returning ONE readiness payload to poll until
 * stage='ready'.
 */
export async function startProjectSession(
  projectId: string,
  sessionId: string,
  // Optional server-side long-poll budget (ms): the server holds the request
  // until readiness flips (or its bounded deadline), so we learn `ready` the
  // instant it happens instead of on a fixed poll tick. Omit = one-shot.
  waitMs?: number,
): Promise<SessionStartResult | null> {
  const qs = waitMs && waitMs > 0 ? `?wait_ms=${Math.floor(waitMs)}` : '';
  const response = await backendApi.post<SessionStartResult>(
    `/projects/${projectId}/sessions/${sessionId}/start${qs}`,
    {},
    // 402 (billing) is handled by the page's plan gate before polling; other
    // failures just yield null and the caller retries.
    { showErrors: false },
  );
  if (!response.success || !response.data) return null;
  return response.data;
}

/**
 * Stable React Query key for the session-open (`/start`) poll. Shared by the
 * session page's useQuery AND every create→navigate site that prefetches it, so
 * the keys can never drift — a mismatch would issue a SECOND `/start` POST
 * instead of adopting the in-flight one.
 */
export function sessionStartKey(projectId: string, sessionId: string) {
  return ['session-start', projectId, sessionId] as const;
}

/**
 * Begin the session runtime boot DURING the route transition (before the session
 * page mounts), so provisioning overlaps navigation instead of starting after the
 * page paints. Idempotent + fire-and-forget: React Query dedupes against the
 * session page's own query (same key), and `/start` is idempotent server-side.
 * Also warms the route bundle. Use at every createProjectSession→navigate site.
 */
export function prefetchSessionStart(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): void {
  void queryClient.prefetchQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => startProjectSession(projectId, sessionId),
    staleTime: 0,
  });
}
