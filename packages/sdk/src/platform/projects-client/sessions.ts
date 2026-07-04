// Project sessions — session CRUD, sharing, public shares, preview candidates.

import { backendApi } from '../api-client';
import { markSessionFresh } from '../fresh-sessions';
import { unwrap, type ConnectorSharing } from './shared';

// ---------------------------------------------------------------------------
// Project sessions — one branch + sandbox per row. session_id == sandbox_id
// == branch_name (same UUID), so "Open session" routes to
// /instances/{session_id}/dashboard.
// ---------------------------------------------------------------------------

export type ProjectSessionStatus =
  | 'queued'
  | 'branching'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'completed';

export interface ProjectSession {
  session_id: string;
  account_id: string;
  project_id: string;
  branch_name: string;
  base_ref: string;
  sandbox_provider: string | null;
  sandbox_id: string;
  sandbox_url: string | null;
  opencode_session_id: string | null;
  /**
   * Resolved display name: the user-set `custom_name` if present, otherwise the
   * auto title mirrored from OpenCode server-side during project session reads.
   */
  name: string | null;
  /**
   * The user-set name override (metadata.custom_name). Authoritative — when
   * present it always wins over the server-mirrored OpenCode title. null = no
   * override (display falls back to the auto title / branch).
   */
  custom_name: string | null;
  agent_name: string | null;
  status: ProjectSessionStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  opencode_sessions: ProjectOpenCodeSession[];
  // Ownership + org-visibility (Phase 2 session sharing).
  created_by?: string | null;
  owner_email?: string | null;
  visibility?: 'private' | 'project' | 'restricted';
  sharing?: ConnectorSharing | null;
  is_owner?: boolean;
  can_manage_sharing?: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectOpenCodeSession {
  id: string;
  title: string | null;
  parent_id: string | null;
  project_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  archived_at: number | null;
}

export async function listProjectSessions(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSession[]>(`/projects/${projectId}/sessions`),
  );
}

/**
 * Set who can see/open a session (private | project | members). Owner or
 * project manager only. Reuses the connector/secret sharing intent shape.
 */
export async function setProjectSessionSharing(
  projectId: string,
  sessionId: string,
  intent: ConnectorSharing,
) {
  return unwrap(
    await backendApi.put<ProjectSession>(
      `/projects/${projectId}/sessions/${sessionId}/sharing`,
      intent,
    ),
  );
}

export interface SessionPreviewCandidate {
  id: string;
  label: string;
  port: number;
  path: string;
  status: 'online' | 'offline' | 'unknown';
  source: string;
}

export interface SessionPublicShare {
  share_id: string;
  session_id: string;
  project_id: string;
  resource_type: 'preview' | 'file' | string;
  label: string;
  port: number | null;
  path: string;
  file_path: string | null;
  mode: 'view' | 'interactive' | string;
  allow_websocket: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  public_token?: string;
  public_path?: string;
  proxy_path?: string;
}

export interface CreateSessionPublicShareInput {
  preview_id?: string;
  preview?: {
    label?: string;
    url?: string;
    port?: number;
    path?: string;
  };
  file?: {
    label?: string;
    path: string;
  };
  mode?: 'view' | 'interactive';
  label?: string;
  expires_at?: string | null;
}

export async function getSessionPreviewCandidates(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.get<{ candidates: SessionPreviewCandidate[] }>(
      `/projects/${projectId}/sessions/${sessionId}/previews`,
    ),
  );
}

export async function listSessionPublicShares(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.get<{ shares: SessionPublicShare[] }>(
      `/projects/${projectId}/sessions/${sessionId}/public-shares`,
      { showErrors: false },
    ),
  );
}

export async function createSessionPublicShare(
  projectId: string,
  sessionId: string,
  input: CreateSessionPublicShareInput,
) {
  return unwrap(
    await backendApi.post<{ share: SessionPublicShare }>(
      `/projects/${projectId}/sessions/${sessionId}/public-shares`,
      input,
    ),
  );
}

export async function revokeSessionPublicShare(
  projectId: string,
  sessionId: string,
  shareId: string,
) {
  return unwrap(
    await backendApi.delete<{ share: SessionPublicShare }>(
      `/projects/${projectId}/sessions/${sessionId}/public-shares/${shareId}`,
    ),
  );
}

export async function createProjectSession(
  projectId: string,
  input?: {
    base_ref?: string;
    agent_name?: string;
    /** Slug of the sandbox template to boot from. Defaults to "default". */
    sandbox_slug?: string;
    initial_prompt?: string;
    name?: string;
    /**
     * Client-generated session id. The API accepts any RFC 4122 v4 UUID;
     * we use this so the FE can navigate optimistically the moment the user
     * clicks "send" — the page renders before the POST has even returned.
     */
    session_id?: string;
  },
) {
  const session = unwrap(
    await backendApi.post<ProjectSession>(
      `/projects/${projectId}/sessions`,
      input ?? {},
    ),
  );
  // Mark freshly-created EMPTY sessions so the session page shows the instant
  // typeable shell instead of the resume loader. THE chokepoint for every empty
  // project-session create path (sidebar button, ⌘T shortcut, command palette).
  // `session_id` is exactly the route param those navigations land on.
  // Skip when an initial_prompt is set: those sessions get a server-side reply,
  // so they must mount the real chat to stream it (the shell would hold it back).
  if (!input?.initial_prompt) {
    markSessionFresh((session as ProjectSession | undefined)?.session_id);
  }
  return session;
}

export async function getProjectSession(
  projectId: string,
  sessionId: string,
  options?: { showErrors?: boolean },
) {
  return unwrap(
    await backendApi.get<ProjectSession>(
      `/projects/${projectId}/sessions/${sessionId}`,
      { showErrors: options?.showErrors },
    ),
  );
}

/** One governed action an agent took in a session (from the executor audit). */
export interface SessionAuditAction {
  execution_id: string;
  action: string;
  connector_id: string | null;
  /** ok | error | denied | pending_approval */
  status: string;
  /** read | write | destructive | null */
  risk: string | null;
  acted_by: string | null;
  acted_by_email: string | null;
  /** Who resolved the gated action — set for both approve and deny; null while
   *  still awaiting a decision. */
  resolved_by: string | null;
  resolved_by_email: string | null;
  result_summary: Record<string, unknown> | null;
  at: string;
  resolved_at: string | null;
}

export interface SessionAudit {
  session_id: string;
  agent: string | null;
  /** False when the account lacks the Enterprise `auditAccess` entitlement —
   *  `actions` then contains only unresolved pending approvals, not the full
   *  historical trail. Absent on older backends (treat as true). */
  audit_access?: boolean;
  count: number;
  actions: SessionAuditAction[];
}

/** Per-session audit trail: every executor-gated action the agent took, with its
 *  risk + allow/ask/block verdict + who resolved it. Visible to anyone who can
 *  see the session (its launcher + project managers). */
export async function getSessionAudit(
  projectId: string,
  sessionId: string,
  limit?: number,
  options?: { showErrors?: boolean },
) {
  const qs = limit ? `?limit=${limit}` : '';
  return unwrap(
    await backendApi.get<SessionAudit>(`/projects/${projectId}/sessions/${sessionId}/audit${qs}`, {
      showErrors: options?.showErrors,
    }),
  );
}

export async function updateProjectSession(
  projectId: string,
  sessionId: string,
  input: {
    name?: string;
    metadata?: Record<string, unknown>;
  },
) {
  return unwrap(
    await backendApi.patch<ProjectSession>(
      `/projects/${projectId}/sessions/${sessionId}`,
      input,
    ),
  );
}

export async function deleteProjectSession(
  projectId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/sessions/${sessionId}`,
    ),
  );
}

export async function restartProjectSession(
  projectId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${projectId}/sessions/${sessionId}/restart`,
      {},
    ),
  );
}

/** Manual pause: stops the running sandbox in place, resumable via start(). */
export async function stopProjectSession(
  projectId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${projectId}/sessions/${sessionId}/stop`,
      {},
    ),
  );
}
