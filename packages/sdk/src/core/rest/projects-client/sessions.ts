// Project sessions — session CRUD, sharing, public shares, preview candidates.

import { backendApi } from '../../http/api-client';
import { markSessionFresh } from '../../http/fresh-sessions';
import { type ConnectorSharing, unwrap } from './shared';
import type { AuditEvent } from './audit';

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
  sandbox_provider: 'daytona' | 'platinum' | 'e2b' | null;
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
  owner_name?: string | null;
  owner_type?: 'user' | 'service_account' | 'unknown' | null;
  visibility?: 'private' | 'project' | 'restricted';
  /** How the session was started — a policy class derived from the caller's
   *  token kind, not the surface. A backend (PAT/service-account) create is
   *  'backend'; a human web session is 'user'. See Kortix-as-a-Backend. */
  origin?: 'user' | 'trigger' | 'schedule' | 'backend' | 'system';
  /** The per-session secrets allowlist that was applied (identifiers); null = none. */
  secrets_allowlist?: string[] | null;
  sharing?: ConnectorSharing | null;
  is_owner?: boolean;
  can_manage_sharing?: boolean;
  /** Whether the current viewer may open/read this session. */
  can_access?: boolean;
  /** Exact lifecycle state of the backing runtime resource, when present. */
  runtime_status?: 'provisioning' | 'active' | 'stopped' | 'error' | 'archived' | null;
  /** Server-managed soft-deletion audit fields, present in project inventory mode. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type SessionRuntimeContextScalar = string | number | boolean | null;
export type SessionRuntimeContext = Record<string, SessionRuntimeContextScalar>;
export interface SessionConnectorBinding {
  connection_id: string;
}
export type SessionConnectorBindings = Record<string, SessionConnectorBinding>;
export type SessionConnectorBindingInput = SessionConnectorBinding;
export type SessionConnectorBindingsInput = Record<string, SessionConnectorBindingInput>;

export interface PendingSessionPrompt {
  text: string;
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  attachment_names?: string[];
}

/**
 * Public body for POST /projects/:workspaceId/sessions.
 *
 * Session create immediately begins runtime provisioning; it is not a deferred
 * metadata-only create. Callers that rotate project secrets or connector
 * credentials for the new session must await those writes before creating it.
 * The later `/start` call is an idempotent readiness/resume operation.
 */
export interface CreateProjectSessionInput {
  base_ref?: string;
  agent_name?: string;
  /** Slug of the sandbox template to boot from. Defaults to "default". */
  sandbox_slug?: string;
  initial_prompt?: string;
  /** Durable recovery copy. The server never delivers this field automatically. */
  pending_prompt?: PendingSessionPrompt;
  opencode_model?: string;
  name?: string;
  /** Client-generated RFC 4122 v4 UUID for optimistic navigation. */
  session_id?: string;
  provider?: 'daytona' | 'platinum' | 'e2b';
  branch_already_created?: boolean;
  metadata?: Record<string, unknown>;
  /** Persisted and injected as one non-secret KORTIX_SESSION_CONTEXT JSON envelope. */
  runtime_context?: SessionRuntimeContext;
  /** Logical connector alias -> active authorization available to the caller. */
  connector_bindings?: SessionConnectorBindingsInput;
  /**
   * When `connector_bindings` is set, unbound aliases fail closed.
   * `inherit_unbound: true` keeps strategy-based default resolution for them.
   */
  inherit_unbound?: boolean;
  /**
   * Connectors that must resolve a strategy-compatible authorization
   * before provisioning. Missing authorizations return
   * `CONNECTOR_CONNECTION_REQUIRED`.
   */
  require_connectors?: string[];
  /**
   * Kortix-as-a-Backend (backend-origin callers only). Narrow which project
   * secrets (by identifier) this session's sandbox receives, from the agent's
   * default set down to this list. `[]` = inject zero project secrets. Pure
   * narrowing — can't widen beyond the agent's grant. Non-backend caller → 403.
   */
  secrets?: string[];
}

export interface WarmProjectSessionWorkspaceRefresh {
  status: 'skipped' | 'unchanged' | 'updated' | 'failed';
  before_sha?: string | null;
  after_sha?: string | null;
  error?: string;
}

export interface WarmProjectSessionResult {
  session: ProjectSession;
  reused: boolean;
  workspace_refresh: WarmProjectSessionWorkspaceRefresh;
}

export interface ClaimWarmProjectSessionInput {
  session_id: string;
  agent_name?: string;
  sandbox_slug?: string;
  pending_prompt?: PendingSessionPrompt;
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

/** @param options.scope - `project` asks for the manager-only full inventory. */
export async function listProjectSessions(
  workspaceId: string,
  options?: { scope?: 'visible' | 'project' },
) {
  const params = new URLSearchParams();
  if (options?.scope && options.scope !== 'visible') params.set('scope', options.scope);
  const query = params.size > 0 ? `?${params}` : '';
  return unwrap(await backendApi.get<ProjectSession[]>(`/projects/${workspaceId}/sessions${query}`));
}

/**
 * Set who can see/open a session (private | project | members). Owner or
 * project manager only. Reuses the connector/secret sharing intent shape.
 */
export async function setProjectSessionSharing(
  workspaceId: string,
  sessionId: string,
  intent: ConnectorSharing,
) {
  return unwrap(
    await backendApi.put<ProjectSession>(
      `/projects/${workspaceId}/sessions/${sessionId}/sharing`,
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

export async function getSessionPreviewCandidates(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.get<{ candidates: SessionPreviewCandidate[] }>(
      `/projects/${workspaceId}/sessions/${sessionId}/previews`,
    ),
  );
}

export async function listSessionPublicShares(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.get<{ shares: SessionPublicShare[] }>(
      `/projects/${workspaceId}/sessions/${sessionId}/public-shares`,
      { showErrors: false },
    ),
  );
}

export async function createSessionPublicShare(
  workspaceId: string,
  sessionId: string,
  input: CreateSessionPublicShareInput,
) {
  return unwrap(
    await backendApi.post<{ share: SessionPublicShare }>(
      `/projects/${workspaceId}/sessions/${sessionId}/public-shares`,
      input,
    ),
  );
}

export async function revokeSessionPublicShare(
  workspaceId: string,
  sessionId: string,
  shareId: string,
) {
  return unwrap(
    await backendApi.delete<{ share: SessionPublicShare }>(
      `/projects/${workspaceId}/sessions/${sessionId}/public-shares/${shareId}`,
    ),
  );
}

/**
 * Create a session and immediately kick its runtime provisioning.
 *
 * Await any project-secret or connector-credential mutations that the runtime
 * must observe before calling this function. `startProjectSession` does not
 * establish a commit barrier for writes raced against this request; it only
 * provisions/resumes idempotently and reports readiness.
 */
export async function createProjectSession(workspaceId: string, input?: CreateProjectSessionInput) {
  const session = unwrap(
    await backendApi.post<ProjectSession>(`/projects/${workspaceId}/sessions`, input ?? {}),
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

export async function ensureWarmProjectSession(workspaceId: string) {
  const result = unwrap(
    await backendApi.post<WarmProjectSessionResult>(`/projects/${workspaceId}/sessions/warm`, {}),
  );
  markSessionFresh(result.session.session_id);
  return result;
}

export async function claimWarmProjectSession(
  workspaceId: string,
  input: ClaimWarmProjectSessionInput,
) {
  const session = unwrap(
    await backendApi.post<ProjectSession>(`/projects/${workspaceId}/sessions/warm/claim`, input, {
      showErrors: false,
    }),
  );
  markSessionFresh(session.session_id);
  return session;
}

export async function getProjectSession(
  workspaceId: string,
  sessionId: string,
  options?: { showErrors?: boolean },
) {
  return unwrap(
    await backendApi.get<ProjectSession>(`/projects/${workspaceId}/sessions/${sessionId}`, {
      showErrors: options?.showErrors,
    }),
  );
}

/** One governed action an agent took in a session (from the connector audit). */
export interface SessionAuditAction {
  execution_id: string;
  action: string;
  connector_id: string | null;
  /** Connector slug — `${connector}.${action}` is the fully-qualified tool
   *  path project policies match against. Null on very old rows whose
   *  connector was deleted. */
  connector?: string | null;
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
  /**
   * Redacted detail the gateway recorded. For a gated call this carries
   * `args_preview` — the (secret-stripped) arguments the call would run with,
   * which is what makes an approval decidable rather than a guess.
   */
  result_summary: Record<string, unknown> | null;
  at: string;
  resolved_at: string | null;
  /**
   * Standalone page for reviewing and deciding this call. Non-null only while
   * the row is unresolved; a settled decision carries no live link.
   */
  approval_url?: string | null;
}

export interface SessionAudit {
  session_id: string;
  agent: string | null;
  /** False when the account lacks the Enterprise `auditAccess` entitlement —
   *  `actions` then contains only unresolved pending approvals, not the full
   *  historical trail. Absent on older backends (treat as true). */
  audit_access?: boolean;
  count: number;
  /** Canonical ordered timeline. Empty for non-entitled accounts. */
  events?: AuditEvent[];
  /** Cursor for the next ordered session page. */
  next_cursor?: string | null;
  actions: SessionAuditAction[];
}

/** Canonical session timeline plus the governed connector approval projection.
 * Visible to anyone who can see the session (its launcher + project managers). */
export async function getSessionAudit(
  workspaceId: string,
  sessionId: string,
  limit?: number,
  options?: { showErrors?: boolean; cursor?: string; includeEvents?: boolean },
) {
  const search = new URLSearchParams();
  if (limit) search.set('limit', String(limit));
  if (options?.cursor) search.set('cursor', options.cursor);
  if (options?.includeEvents != null)
    search.set('include_events', String(options.includeEvents));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<SessionAudit>(
      `/projects/${workspaceId}/sessions/${sessionId}/audit${qs ? `?${qs}` : ''}`,
      {
        showErrors: options?.showErrors,
      },
    ),
  );
}

export interface SessionTranscriptToolCall {
  tool: string;
  status: string | null;
}

export interface SessionTranscriptMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: SessionTranscriptToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
  error: { name?: string; message?: string } | null;
}

/** Compact server-side transcript read — text + tool calls, stripped of tool
 *  inputs/outputs, for project automation (callable with project-scoped
 *  session tokens, unlike the raw sandbox proxy). */
export interface SessionTranscript {
  available: boolean;
  reason: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: SessionTranscriptMessage[];
}

export async function getSessionTranscript(
  workspaceId: string,
  sessionId: string,
  options?: { limit?: number; chars?: number },
) {
  const search = new URLSearchParams();
  if (options?.limit != null) search.set('limit', String(options.limit));
  if (options?.chars != null) search.set('chars', String(options.chars));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<SessionTranscript>(
      `/projects/${workspaceId}/sessions/${sessionId}/transcript${qs ? `?${qs}` : ''}`,
    ),
  );
}

/** One line of a session's voice-call transcript (`kortix.voice_call_turns`).
 *  'user'/'agent' are either side of the spoken conversation; 'tool' is a
 *  record of an `ask_kortix`/`run_command` call the voice-agent worker made
 *  through the voice MCP (see apps/api/src/channels/voice/mcp.ts) — not
 *  spoken, but part of "what did the voice agent DO" during the call. */
export interface VoiceTranscriptTurn {
  cursor: number;
  role: 'user' | 'agent' | 'tool' | (string & {});
  speaker: string | null;
  text: string;
  at: string;
}

export interface VoiceTranscript {
  session_id: string;
  call_id: string;
  /** Whether a voice-agent worker is in the call's LiveKit room right now. */
  live: boolean;
  /** Highest `cursor` returned — pass back as `cursor` to page for only what's new. */
  cursor: number;
  count: number;
  turns: VoiceTranscriptTurn[];
}

/** A session's live voice-call transcript — every spoken turn plus every
 *  ask_kortix/run_command the worker issued, in one monotonic feed (a call's
 *  `callId` IS its `sessionId`, so there is nothing else to key this by).
 *  Visible to anyone who can see the session (same gate as `/audit`,
 *  `/transcript`). Returns `{ turns: [] }` for a session that never made a
 *  voice call — not a 404, since "no call yet" is the common case. */
export async function getVoiceTranscript(
  workspaceId: string,
  sessionId: string,
  options?: { cursor?: number; limit?: number; showErrors?: boolean },
) {
  const search = new URLSearchParams();
  if (options?.cursor != null) search.set('cursor', String(options.cursor));
  if (options?.limit != null) search.set('limit', String(options.limit));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<VoiceTranscript>(
      `/projects/${workspaceId}/sessions/${sessionId}/voice-transcript${qs ? `?${qs}` : ''}`,
      { showErrors: options?.showErrors },
    ),
  );
}

export async function updateProjectSession(
  workspaceId: string,
  sessionId: string,
  input: {
    name?: string;
    metadata?: Record<string, unknown>;
  },
) {
  return unwrap(
    await backendApi.patch<ProjectSession>(`/projects/${workspaceId}/sessions/${sessionId}`, input),
  );
}

export async function deleteProjectSession(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${workspaceId}/sessions/${sessionId}`),
  );
}

export async function restartProjectSession(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${workspaceId}/sessions/${sessionId}/restart`,
      {},
    ),
  );
}

/** Manual pause: stops the running sandbox in place, resumable via start(). */
export async function stopProjectSession(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${workspaceId}/sessions/${sessionId}/stop`,
      {},
    ),
  );
}

/**
 * Whether a session is running the agent config the manifest compiles to now.
 *
 * A session's agent behaviour is compiled from git ONCE, at provision, and
 * frozen into the sandbox's environment. Merging an agent change does not reach
 * a session that is already open — this is how you find out, and
 * `reloadProjectSessionConfig` is how you fix it.
 */
export interface SessionConfigState {
  /** The ref the session compiles from — its own `base_ref`, else the default branch. */
  base_ref: string;
  /** Content hash of the config the BOX says it spawned with. */
  running_etag: string | null;
  /** Content hash of what the manifest compiles to right now. */
  latest_etag: string | null;
  commit_sha: string | null;
  /**
   * TRI-STATE, and the distinction is the point.
   *
   * `null` means "could not tell", NEVER "up to date": the sandbox is
   * unreachable, or the project has no compiled config at all (a v1
   * `kortix.toml` project). Branch on `=== true` and `=== false`; `!stale`
   * silently reports an unaskable session as current, which is the exact
   * failure this field exists to prevent.
   */
  stale: boolean | null;
  sandbox_reachable: boolean;
}

/**
 * Not cheap — the server drops the project's git-mirror TTL, recompiles the
 * manifest, and calls into the sandbox. Fetch it on mount and on focus; do not
 * poll it on a timer.
 *
 * `showErrors: false` because this is a BACKGROUND probe nobody asked for. It
 * runs on every session mount, and a session that is still materializing 404s —
 * with the default the host's global error handler would toast at a user who
 * merely opened a new session, on every focus, forever. A failure here already
 * has a meaning ("could not tell"), and that is the caller's to render.
 */
export async function getProjectSessionConfigState(
  workspaceId: string,
  sessionId: string,
): Promise<SessionConfigState> {
  return unwrap(
    await backendApi.get<SessionConfigState>(
      `/projects/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/config`,
      { showErrors: false },
    ),
  );
}

/**
 * The outcome of a reload.
 *
 * `applied: false` arrives with HTTP **200**, not an error — "there was nothing
 * to do" and "it worked" are both successful requests. Check `applied`, never
 * the status code. On a non-applied result `etag` echoes the OLD hash rather
 * than reporting a change that did not happen.
 */
export interface SessionReloadResult {
  /** True only when the config the box runs was actually replaced. */
  applied: boolean;
  previous_etag: string | null;
  etag: string | null;
  repo_refreshed: boolean;
  commit_sha: string | null;
  /**
   * What happened to the agent files opencode ACTUALLY reads.
   *
   * This — not `applied` — decides whether the agent behaves differently.
   * opencode is spawned with `OPENCODE_CONFIG_DIR` pointing into the session's
   * working tree, and the agent `.md` files there beat the compiled config the
   * reload pushes as JSON, so anything but `'updated'` means the hash moved and
   * the agent did not.
   *
   * Three of these are successes (`updated`, `already-current`,
   * `not-applicable`), one is a deliberate refusal to discard the session's own
   * edits (`kept-yours`), and two are different flavours of "we did not find
   * out" (`not-requested` when `refresh_repo: false`, `unknown` for a sandbox
   * whose daemon predates the sync). Absent on a response from an older API.
   *
   * Prefer `detail` for display — it already words every case.
   */
  agent_files?:
    | 'updated'
    | 'already-current'
    | 'kept-yours'
    | 'not-applicable'
    | 'not-requested'
    | 'unknown';
  /** Why nothing was applied. Internal wording — map it, don't render it. */
  reason?: string;
  detail: string;
}

/**
 * Recompile the agent config from git and push it into a RUNNING session.
 *
 * This RESTARTS opencode, which ENDS an in-flight turn. The API refuses by
 * default while a turn is running and answers 409 with `code: 'SESSION_BUSY'`
 * and a `reason`; `force: true` overrides and discards that turn, so it belongs
 * behind a confirmation, never behind a silent retry.
 *
 * `showErrors: false` because the 409 is not an error to announce — it is a
 * question ("end the running turn?"), and the caller answers it with a confirm.
 * Letting the host's global handler toast it too would talk over that dialog,
 * and would double up on every other failure the caller already reports.
 */
export async function reloadProjectSessionConfig(
  workspaceId: string,
  sessionId: string,
  input: { refresh_repo?: boolean; force?: boolean } = {},
): Promise<SessionReloadResult> {
  return unwrap(
    await backendApi.post<SessionReloadResult>(
      `/projects/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/reload`,
      input,
      { showErrors: false },
    ),
  );
}

/**
 * Change the model a session uses, mid-flight.
 *
 * `opencode_model` is set at create; this re-points an existing session. When
 * the sandbox is live the change takes effect immediately (opencode restarts to
 * rebuild its config), which ends any in-flight turn. `applied_live: false`
 * means it was stored and will apply when the sandbox next starts.
 */
/** What a re-scope may change, and what it reports back. */
export interface SessionScopeInput {
  /**
   * FULL new allowlist — this REPLACES the previous one. `null` stops narrowing
   * (fall back to the agent's own grant); `[]` means "no project secrets at
   * all". Those two are opposite, so the field is optional: omit it to leave
   * secrets untouched.
   */
  secrets?: string[] | null;
  /** FULL new binding map — REPLACES the previous one. Omit to leave untouched. */
  connector_bindings?: SessionConnectorBindingsInput;
  /**
   * FULL new list of connector aliases this session REQUIRES — REPLACES the
   * previous one. Omit to leave untouched.
   *
   * Unlike `connector_bindings`, an alias here needs nothing connected to it:
   * that is the point. A binding says "use THIS connection" and must carry an
   * connection id, so it cannot express "this session needs Gmail and has
   * none". Naming an alias here makes the next turn stop with
   * `CONNECTOR_CONNECTION_REQUIRED` and a connect prompt instead of letting
   * the agent discover the gap mid-answer.
   */
  require_connectors?: string[] | null;
}

export interface SessionScope {
  secrets_allowlist: string[] | null;
  /** Aliases this session requires, connected or not. See `require_connectors`. */
  required_connectors: string[] | null;
  connector_bindings: SessionConnectorBindings;
  dropped_secrets: string[];
  added_secrets: string[];
  dropped_bindings: string[];
  /**
   * False when a secret was dropped. Connector bindings resolve server-side at
   * call time so they take effect immediately, but a secret the agent has
   * already read stays in its context and in shells it already started —
   * dropping it stops future DELIVERY, it does not un-read the value. Surface
   * this rather than reporting a plain success.
   */
  retroactive: boolean;
  detail: string;
}

/** @deprecated Use `SessionScope`. */
export type SessionScopeResult = SessionScope;

export async function getProjectSessionScope(
  workspaceId: string,
  sessionId: string,
): Promise<SessionScope> {
  return unwrap(
    await backendApi.get<SessionScope>(
      `/projects/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/scope`,
    ),
  );
}

/**
 * Re-scope a RUNNING session. Set semantics: what you send replaces what was
 * there, and takes effect from the next prompt.
 */
export async function setProjectSessionScope(
  workspaceId: string,
  sessionId: string,
  scope: SessionScopeInput,
): Promise<SessionScope> {
  return unwrap(
    await backendApi.put<SessionScope>(
      `/projects/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/scope`,
      scope,
    ),
  );
}

export interface SessionModelChangeResult {
  opencode_model: string;
  /** True only when a LIVE sandbox took the new model. */
  applied_live: boolean;
  /**
   * `true` when a live push was required and FAILED: the model is stored, but
   * the running harness still answers from the OLD one.
   *
   * Check this, never `!applied_live`, before telling a user the change landed.
   * `applied_live: false` is also the ordinary answer for a session with no live
   * sandbox, where the stored value IS the mechanism and the next start reads
   * it. Treating the two the same is how a `502` env-sync failure got reported
   * as "saved — applies when this session next starts".
   */
  push_failed?: true;
  detail?: string;
}

export async function setProjectSessionModel(
  workspaceId: string,
  sessionId: string,
  opencodeModel: string,
): Promise<SessionModelChangeResult> {
  return unwrap(
    await backendApi.put<SessionModelChangeResult>(
      `/projects/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/model`,
      { opencode_model: opencodeModel },
    ),
  );
}
