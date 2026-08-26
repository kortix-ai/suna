// Project sessions — session CRUD, sharing, public shares, preview candidates.

import { ApiError, type ApiClientOptions, backendApi } from '../../http/api-client';
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
   * Resolved display name. Precedence: the user-set `custom_name`, then the
   * runtime's own root-conversation title (the `opencode_sessions` snapshot —
   * the same string the session header shows), then the Kortix-generated
   * first-prompt title (`metadata.name`).
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
  /**
   * May the viewer change WHO CAN OPEN this session? The session owner's call —
   * a project manager who did not create it cannot rewrite the visibility of a
   * session they are not allowed to read. The one exception is a session owned
   * by a service account (a trigger or agent run), which a project manager
   * governs because no human is there to.
   */
  can_manage_sharing?: boolean;
  /**
   * May the viewer stop, restart, delete it, or change its model? Owner OR
   * project manager. Deliberately separate from `can_manage_sharing`: a manager
   * must be able to shut down a runaway session without gaining the right to
   * re-share its contents.
   */
  can_manage_lifecycle?: boolean;
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
  /**
   * Full prompt parts, in OpenCode's wire shape. Lets the first prompt carry
   * attachments as `data:` URLs — the session's sandbox does not exist yet,
   * so there is nowhere to upload into. When present, these are what the
   * server enqueues; `text` remains the flat copy for previews and titling.
   */
  parts?: SessionPromptPart[];
}

/**
 * Public body for POST /projects/:projectId/sessions.

 * The server converts `pending_prompt` into a durable prompt-inbox row inside
 * the create transaction and stores only its picks in session metadata — see
 * apps/api's `convertPendingPromptToInboxRow`.
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
  /**
   * Client metadata. Server-owned lifecycle and trigger-attribution keys are
   * rejected, including `source`, `trigger_kind`, and `trigger_slug`.
   */
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

/**
 * @param options.scope - `project` asks for the manager-only lifecycle
 * inventory. Both scopes omit sessions the caller cannot open.
 */
export async function listProjectSessions(
  projectId: string,
  options?: { scope?: 'visible' | 'project' },
) {
  const params = new URLSearchParams();
  if (options?.scope && options.scope !== 'visible') params.set('scope', options.scope);
  const query = params.size > 0 ? `?${params}` : '';
  return unwrap(await backendApi.get<ProjectSession[]>(`/projects/${projectId}/sessions${query}`));
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
  /**
   * Absolute URL the share opens at — the sandbox's own preview ORIGIN when the
   * deployment serves one. Prefer this over `proxy_path`: under the path form a
   * shared app's root-absolute links resolve against the API origin, and shared
   * file content renders with the API's principal. Null when the deployment has
   * no preview domain, in which case `proxy_path` is still correct.
   */
  public_url?: string | null;
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

/**
 * Create a session and immediately kick its runtime provisioning.
 *
 * Await any project-secret or connector-credential mutations that the runtime
 * must observe before calling this function. `startProjectSession` does not
 * establish a commit barrier for writes raced against this request; it only
 * provisions/resumes idempotently and reports readiness.
 */
export async function createProjectSession(projectId: string, input?: CreateProjectSessionInput) {
  const session = unwrap(
    await backendApi.post<ProjectSession>(`/projects/${projectId}/sessions`, input ?? {}),
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

export interface EnsureWarmProjectSessionOptions {
  /**
   * The id of a warm session this call must NOT reuse — typically the one the
   * caller just took for a send. The server's reuse lookup skips it even
   * though its `metadata.warm` marker is still set (it only drops when the
   * first prompt reaches the preview proxy, seconds after take), so a
   * replenish fired in that window creates a FRESH session instead of handing
   * the just-taken one straight back.
   */
  excludeSessionId?: string;
}

/**
 * Pre-create the session a present user is about to start.
 *
 * Speculative by contract: the caller ignores every failure and falls through to
 * `createProjectSession`, which re-evaluates every gate and surfaces the real
 * error. `showErrors: false` keeps the recoverable `409 WARM_SESSION_UNAVAILABLE`
 * — an account with no concurrent-session headroom, a project whose repo cannot
 * be read — out of the global error sink, where it became a toast on an ordinary
 * project page view.
 */
export async function ensureWarmProjectSession(
  projectId: string,
  options?: EnsureWarmProjectSessionOptions,
) {
  const body = options?.excludeSessionId ? { exclude_session_id: options.excludeSessionId } : {};
  const result = unwrap(
    await backendApi.post<WarmProjectSessionResult>(`/projects/${projectId}/sessions/warm`, body, {
      showErrors: false,
    }),
  );
  // A REUSED session is, by definition, not fresh: it is the same session a
  // previous take (or a previous tab) already consumed, possibly with turns
  // already in flight. Marking it fresh painted the resumed session as an
  // instant typeable EMPTY shell, hiding exactly the mis-delivery this whole
  // exclusion mechanism exists to prevent.
  if (!result.reused) markSessionFresh(result.session.session_id);
  return result;
}

/**
 * @deprecated A warm session is an ordinary session. Navigate to
 * `ensureWarmProjectSession`'s `session.session_id` and prompt it — the first
 * prompt makes it visible on its own. This call remains only so consumers
 * pinned to an older shape keep working; it will be removed in the next major.
 */
export async function claimWarmProjectSession(
  projectId: string,
  input: ClaimWarmProjectSessionInput,
) {
  const session = unwrap(
    await backendApi.post<ProjectSession>(`/projects/${projectId}/sessions/warm/claim`, input, {
      showErrors: false,
    }),
  );
  markSessionFresh(session.session_id);
  return session;
}

export async function getProjectSession(
  projectId: string,
  sessionId: string,
  options?: { showErrors?: boolean },
) {
  return unwrap(
    await backendApi.get<ProjectSession>(`/projects/${projectId}/sessions/${sessionId}`, {
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
  projectId: string,
  sessionId: string,
  limit?: number,
  options?: { showErrors?: boolean; cursor?: string; includeEvents?: boolean },
) {
  const search = new URLSearchParams();
  if (limit) search.set('limit', String(limit));
  if (options?.cursor) search.set('cursor', options.cursor);
  if (options?.includeEvents != null) search.set('include_events', String(options.includeEvents));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<SessionAudit>(
      `/projects/${projectId}/sessions/${sessionId}/audit${qs ? `?${qs}` : ''}`,
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

/**
 * Which source answered a transcript read.
 *
 * `live` is the sandbox's own OpenCode endpoint. `mirror` is the durable
 * server-side copy the control plane writes at turn end, which is what lets a
 * STOPPED or waking session answer at all. `none` is the honest "nothing could
 * answer" and is the only value that accompanies `available: false`. The two
 * sources are never merged — this field says which one you got.
 */
export type SessionTranscriptSource = 'live' | 'mirror' | 'none';

/** Compact server-side transcript read — text + tool calls, stripped of tool
 *  inputs/outputs, for project automation (callable with project-scoped
 *  session tokens, unlike the raw sandbox proxy). */
export interface SessionTranscript {
  available: boolean;
  reason: string | null;
  source: SessionTranscriptSource;
  /** The response contains the session's FIRST message. False means "this is a
   *  tail", never "something is broken". */
  complete: boolean;
  /** When the mirror was last written; null for a live read. */
  captured_at: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: SessionTranscriptMessage[];
}

/** One mirrored message in the shape the session sync store hydrates from:
 *  OpenCode's own envelope, with the parts array stripped of tool
 *  inputs/outputs and file urls. */
export interface SessionTranscriptSyncMessage {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

/**
 * The durable transcript mirror, in sync-store shape.
 *
 * `source` is `mirror` or `none` — never `live`. A client whose sandbox is up
 * reads the runtime directly, so this endpoint deliberately does not re-proxy
 * it.
 */
export interface SessionTranscriptSyncEnvelope {
  available: boolean;
  reason: string | null;
  source: SessionTranscriptSource;
  complete: boolean;
  captured_at: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: SessionTranscriptSyncMessage[];
}

export async function getSessionTranscript(
  projectId: string,
  sessionId: string,
  options?: { limit?: number; chars?: number },
) {
  const search = new URLSearchParams();
  if (options?.limit != null) search.set('limit', String(options.limit));
  if (options?.chars != null) search.set('chars', String(options.chars));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<SessionTranscript>(
      `/projects/${projectId}/sessions/${sessionId}/transcript${qs ? `?${qs}` : ''}`,
    ),
  );
}

/**
 * Read the durable server-side transcript mirror for a session.
 *
 * This is the ONE read that answers while the sandbox is down. It exists so a
 * hibernated session can paint its history immediately instead of showing a
 * full-screen loader for the length of the wake (measured 5-240 s).
 *
 * Messages carry OpenCode's real ids, so a client hydrates them provisionally
 * (`hydrate(..., { source: 'cache' })`) and the live runtime read SETTLES them
 * by id rather than duplicating them.
 */
export async function getSessionTranscriptSync(
  projectId: string,
  sessionId: string,
  options?: { limit?: number; signal?: AbortSignal },
) {
  const search = new URLSearchParams({ shape: 'sync' });
  if (options?.limit != null) search.set('limit', String(options.limit));
  return unwrap(
    await backendApi.get<SessionTranscriptSyncEnvelope>(
      `/projects/${projectId}/sessions/${sessionId}/transcript?${search.toString()}`,
      { showErrors: false },
    ),
  );
}

/** 'delivering' — the control plane minted the turn but has not confirmed
 *  OpenCode received it. 'active' — the runtime accepted it and is working. */
export type SessionTurnState = 'delivering' | 'active';

/** A turn the control plane's lifecycle authority is holding open right now. */
export interface SessionTurn {
  turn_token: string;
  state: SessionTurnState;
  message_id: string | null;
  opencode_session_id: string | null;
  /** Null only for a legacy authority record written before the control plane
   *  recorded a start instant. The turn is running either way — a missing
   *  timestamp is not a reason to read it as idle. */
  started_at: string | null;
  /** When the runtime confirmed the turn. Null while it is still `delivering`,
   *  and null for an accepted turn whose ledger row never landed. */
  accepted_at: string | null;
}

/** How the most recent turn ended. Present only when no turn is running —
 *  it is what separates "this session has never run a turn" from "the last
 *  one just finished". */
export interface SessionTurnEnded {
  turn_token: string;
  end_reason: string | null;
  ended_at: string | null;
}

export interface SessionTurnStatus {
  /** Every turn running right now, newest start first. EMPTY means idle —
   *  a session can hold more than one open turn (a trigger delivery and a web
   *  prompt, say), so this is a list and never a single turn. */
  turns: SessionTurn[];
  last_ended?: SessionTurnEnded;
}

/** Server truth about this session's running turns (`GET .../turn`), answered
 *  independently of the live stream.
 *
 *  `turns` comes from the control plane's LIFECYCLE AUTHORITY — the same record
 *  the reaper renews deadlines from — so it is true for a turn the durable
 *  ledger has not recorded yet (a boot prompt has no ledger row until the
 *  runtime accepts it) and false for a stale ledger row left open by a write
 *  that failed. `last_ended` is history, and history comes from the ledger,
 *  which retains terminal rows the authority erases. */
export async function getSessionTurn(
  projectId: string,
  sessionId: string,
): Promise<SessionTurnStatus> {
  return unwrap(
    await backendApi.get<SessionTurnStatus>(`/projects/${projectId}/sessions/${sessionId}/turn`),
  );
}

// ── The session-open bundle ─────────────────────────────────────────────────
//
// ONE round trip for everything a session view needs to PAINT and ARM: the
// session row, the running turns, the prompt queue, the durable transcript
// mirror, the composer's control-plane essentials, and the model defaults.
// It replaces 6 serial reads on the open path and introduces NO new truth —
// every leg is byte-identical to the endpoint that already served it, so a
// consumer can hand a leg straight to the code that reads that endpoint.
//
// EVERY LEG IS TRI-STATE. `known: false` means the server could not answer
// that leg, and the client must render UNKNOWN — never idle, never an empty
// queue, never "no transcript". A default rendered as an answer is the defect
// class the bundle exists to remove; it must not come back wearing this name.

/** A leg the server could not answer. Render the fact as UNKNOWN. */
export interface SessionOpenBundleUnknown {
  known: false;
  reason: string;
}

/** = `GET .../turn`, plus the tri-state tag. */
export type SessionOpenBundleTurn =
  | ({ known: true } & SessionTurnStatus)
  | SessionOpenBundleUnknown;

/** = `GET .../prompts`, plus whether Stop is holding the whole queue. */
export type SessionOpenBundleQueue =
  | { known: true; prompts: SessionPrompt[]; held: boolean }
  | SessionOpenBundleUnknown;

/** = `GET .../transcript?shape=sync`. `requested: false` answers a
 *  `transcript: 0` read: the caller asked for the pointer only, which is NOT
 *  the same as the transcript being unknown. */
export type SessionOpenBundleTranscript =
  | { known: true; requested: false }
  | ({ known: true; requested: true } & SessionTranscriptSyncEnvelope)
  | SessionOpenBundleUnknown;

/** Composer essentials that need no sandbox. Deliberately NOT the `/config`
 *  route's freshness verdict — that one compiles the manifest and re-reads the
 *  box, which a first paint must never wait on. */
export interface SessionOpenBundleConfig {
  known: true;
  base_ref: string | null;
  agent_name: string | null;
  llm_gateway_enabled: boolean;
}

/** = `GET /projects/:id/model-defaults`. `known: false` with
 *  `reason: 'llm_gateway_disabled'` mirrors that route's own 404. */
export type SessionOpenBundleModels =
  | {
      known: true;
      platformDefault: string | null;
      accountDefault: string | null;
      agentDefaults: Record<string, string>;
      projectDefault: string | null;
      resolvedForCaller: string | null;
      resolvedSource: string;
      freeTier: boolean;
    }
  | SessionOpenBundleUnknown;

/** Identity the LIVE runtime would also produce for this projection. It travels
 *  with the document so a cached roster whose id the live read will not also
 *  produce can be REFUSED rather than rendered — the transcript mirror's
 *  ghost rule, applied to config state. */
export interface SessionRuntimeIdentity {
  opencode_session_id: string | null;
  opencode_version: string | null;
  daemon_build: number | null;
  agent_config_etag: string | null;
  /** OpenCode's OWN durable cursor per aggregate — NOT the stream's `seq`. */
  head_seq: Record<string, number> | null;
}

/**
 * = the sandbox daemon's `GET /kortix/opencode/state`, served from the control
 * plane's projection store.
 *
 * This is the leg that replaces SEVEN proxied reads (`/agent` `/command`
 * `/config` `/session` `/session/status` `/permission` `/question`) — measured
 * at ~3.3 MB and ~1.4 s each across the edge hop — with a Postgres read. It is
 * also what lets a STOPPED session answer "which agents, which commands, what
 * model" at all.
 *
 * `known: false` reasons, and nothing else:
 *   `no_projection`      — nothing has ever been captured for this session.
 *   `identity_mismatch`  — the projection belongs to a different OpenCode root.
 *   `stale`              — a RUNNING box's projection has aged out. A STOPPED
 *                          box's never does: it cannot change, so its last
 *                          capture is its true state.
 *
 * `epoch` + `seq` are the daemon's stream cursor AT CAPTURE. Hand them straight
 * to `sessionStreamPath(...)` so seeding and streaming cannot disagree about
 * what has already been applied.
 */
export type SessionOpenBundleRuntime =
  | {
      known: true;
      fresh: boolean;
      source: 'daemon_push' | 'api_pull';
      captured_at: string;
      age_ms: number;
      runtime_running: boolean;
      epoch: string | null;
      seq: number | null;
      identity: SessionRuntimeIdentity;
      /** The `/kortix/opencode/state` document, verbatim. Every section inside
       *  is itself `{known, reason?, value}` — see the daemon contract. */
      state: Record<string, unknown>;
    }
  | SessionOpenBundleUnknown;

export interface SessionOpenBundle {
  /** ONE clock for the whole envelope. Every leg is a snapshot at this instant,
   *  and every projection that ranks a server observation against local
   *  optimistic state must stamp from HERE, never from arrival time. */
  observed_at: string;
  session: ProjectSession;
  turn: SessionOpenBundleTurn;
  queue: SessionOpenBundleQueue;
  transcript: SessionOpenBundleTranscript;
  config: SessionOpenBundleConfig;
  models: SessionOpenBundleModels;
  runtime: SessionOpenBundleRuntime;
}

/**
 * Read the session-open bundle.
 *
 * `transcript` is the mirrored-message window: the default matches the SDK's
 * own first-paint span, and `0` asks for the pointer only — what a client whose
 * store is already warm wants, because it needs the identity and the count to
 * TRUST what it holds, not the bytes it already has.
 */
export async function getSessionOpenBundle(
  projectId: string,
  sessionId: string,
  options?: { transcript?: number; signal?: AbortSignal },
): Promise<SessionOpenBundle> {
  const search = new URLSearchParams();
  if (options?.transcript != null) search.set('transcript', String(options.transcript));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<SessionOpenBundle>(
      `/projects/${projectId}/sessions/${sessionId}/open-bundle${qs ? `?${qs}` : ''}`,
      { signal: options?.signal },
    ),
  );
}

// ── The prompt inbox ────────────────────────────────────────────────────────
//
// A user prompt is a DURABLE SERVER ROW from the instant the composer accepts
// it, not a browser object. The queue used to live in localStorage, so closing
// the tab, moving to another device, or a crash lost queued messages silently,
// and two tabs on one session disagreed about what was pending.
//
// The client still mints the wire `messageID` and sends it here verbatim:
// OpenCode decides "has this prompt already been answered?" by id ORDER, and
// only a process holding the transcript can place an id correctly. The server
// re-mints one exactly once — when it redelivers a prompt whose turn provably
// never ran, after re-reading the transcript itself.

export interface SessionPromptPart {
  type: 'text' | 'file' | 'agent';
  text?: string;
  mime?: string;
  url?: string;
  filename?: string;
  name?: string;
  source?: unknown;
}

/** The agent/model/variant/directory captured at SUBMIT time. A prompt that
 *  waits out a long turn still runs with the picks the user made then. */
export interface SessionPromptOverrides {
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  directory?: string | null;
}

/**
 * `queued` — accepted, waiting its turn to be claimed.
 * `delivering` — claimed and on the wire to the runtime.
 * `waiting` — refused admission for now; `reason` says why.
 * `failed` — delivery gave up; retryable through `retrySessionPrompt`.
 *
 * A DELIVERED prompt has no state here at all: it is in the transcript, and
 * listing it as well would render it twice.
 */
export type SessionPromptState = 'queued' | 'delivering' | 'waiting' | 'failed';

export interface SessionPrompt {
  prompt_id: string;
  /** The host's own stable submission name — the same value re-POSTing is a
   *  no-op on, and the key an optimistic row is matched by. */
  client_message_id: string;
  /** The OpenCode wire id this prompt will be delivered under. Moves to the
   *  server's re-minted id the moment the drain places the prompt — BEFORE
   *  the runtime echoes it. */
  message_id: string;
  /** The wire id the HOST painted its bubble under (the one it minted and
   *  POSTed). Together with `message_id` these are every id this prompt has
   *  ever had; a host hides the row when the transcript shows EITHER. Absent
   *  from servers older than this field. */
  wire_message_id?: string;
  state: SessionPromptState;
  /** Why the prompt is `waiting`: `older_prompt_pending` (its own queue is
   *  ahead of it) or `held` (the user pressed Stop — only an explicit send or
   *  send-now releases it). A running turn is NOT one of them: the control
   *  plane forwards a prompt into a live turn, and OpenCode runs it in arrival
   *  order. */
  reason: string | null;
  /** Flattened text preview, capped server-side. */
  text: string;
  /** The sender tab's clock at Enter, when the producer supplied it. */
  client_sent_at_ms?: number | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  available_at: string;
}

export interface CreateSessionPromptResult {
  prompt_id: string;
  state: SessionPromptState;
  message_id: string;
  /** The submission name already named a row: this call added nothing. */
  deduped: boolean;
}

export interface CreateSessionPromptInput {
  clientMessageId: string;
  messageId: string;
  parts: SessionPromptPart[];
  overrides?: SessionPromptOverrides;
  /**
   * Ask the server to re-mint `messageId` against the live transcript before
   * it delivers.
   *
   * OpenCode resolves "has this prompt been answered?" by id ORDER, so an id
   * that sorts below what is on record is accepted and then silently never
   * runs. A caller that minted its id where the live transcript was NOT
   * readable — the one-time localStorage migration, which mints at page load
   * for a message typed before the last reload — says so here, and the control
   * plane places the id correctly at delivery time.
   *
   * Leave it unset for an ordinary send: that id is minted against a
   * transcript the tab can see, and re-minting it would put a sandbox read on
   * the delivery path of every message.
   */
  remintOnDelivery?: boolean;
  /**
   * The tab's own clock at the moment the user pressed Enter. The server
   * preserves SEND order with it when several prompts race in over different
   * surfaces (the boot shell and the chat both send during the crossfade, and
   * their POSTs finish in either order). Milliseconds since epoch.
   */
  clientSentAtMs?: number;
}

/** Put one prompt in the session's server-side inbox (`POST .../prompts`).
 *  Resolving means the prompt is DURABLE, not that it has been delivered. */
export async function createSessionPrompt(
  projectId: string,
  sessionId: string,
  input: CreateSessionPromptInput,
): Promise<CreateSessionPromptResult> {
  return unwrap(
    await backendApi.post<CreateSessionPromptResult>(
      `/projects/${projectId}/sessions/${sessionId}/prompts`,
      {
        client_message_id: input.clientMessageId,
        message_id: input.messageId,
        parts: input.parts,
        ...(input.overrides ? { overrides: input.overrides } : {}),
        ...(input.remintOnDelivery ? { remint_on_delivery: true } : {}),
        ...(typeof input.clientSentAtMs === 'number'
          ? { client_sent_at_ms: Math.trunc(input.clientSentAtMs) }
          : {}),
      },
    ),
  );
}

/** Every prompt this session still owes the user, oldest first. Delivered
 *  prompts are omitted — they are in the transcript. */
export async function listSessionPrompts(
  projectId: string,
  sessionId: string,
): Promise<{ prompts: SessionPrompt[] }> {
  return unwrap(
    await backendApi.get<{ prompts: SessionPrompt[] }>(
      `/projects/${projectId}/sessions/${sessionId}/prompts`,
    ),
  );
}

/**
 * The prompt a DELETE removed, in the shape that re-creates it exactly.
 *
 * Deliberately not a `SessionPrompt`: that carries a truncated text PREVIEW and
 * no parts at all, because it is what a queue row RENDERS. Undoing a removal
 * from that shape silently drops every attachment, the agent/model/variant
 * picks, and anything past the truncation — under a button labelled "Undo".
 */
export interface RemovedSessionPrompt {
  prompt_id: string;
  client_message_id: string;
  message_id: string;
  /** Every wire id this prompt ever travelled under — for clearing the
   *  transcript husk a cancel leaves at the runtime. */
  removed_message_ids?: string[];
  parts: SessionPromptPart[];
  overrides: SessionPromptOverrides | null;
}

/**
 * Drop a prompt — queued, or already on the wire but not yet read by a model
 * step (the server takes the runtime's copy back out; only "already being
 * answered" refuses with 409). `promptId` may be the row id or, once the row
 * has left the list, the message's own `msg_…` wire id.
 *
 * Returns the removed prompt, because the row is HARD-deleted: re-POSTing this
 * result with its original `client_message_id` is the only lossless undo.
 */
export async function deleteSessionPrompt(
  projectId: string,
  sessionId: string,
  promptId: string,
): Promise<RemovedSessionPrompt> {
  const body = unwrap(
    await backendApi.delete<{ removed: RemovedSessionPrompt }>(
      `/projects/${projectId}/sessions/${sessionId}/prompts/${promptId}`,
    ),
  );
  return body.removed;
}

/**
 * Run THIS prompt next — the one primitive behind both "retry" and "send now".
 *
 * They are one intent: the user pointed at a row and asked for that message.
 * The row is re-queued, put ahead of the ordering rule, and the session's hold
 * is released so the rest drains at the next boundary. Its wire id is
 * UNCHANGED, so a delivery that actually landed is still absorbed by the proxy
 * instead of running twice.
 */
export async function retrySessionPrompt(
  projectId: string,
  sessionId: string,
  promptId: string,
): Promise<SessionPrompt> {
  return unwrap(
    await backendApi.post<SessionPrompt>(
      `/projects/${projectId}/sessions/${sessionId}/prompts/${promptId}/retry`,
      {},
    ),
  );
}

/**
 * Hold — or release — every queued prompt of this session.
 *
 * What the Stop button writes. "Stopping means stop doing things, and that
 * includes the queue" was a browser-local pause while the queue was
 * browser-local; with the queue in Postgres, a client-side pause leaves the
 * server free to admit the prompt the user pressed Stop to get ahead of, about
 * one scheduler tick after the abort clears turn authority.
 *
 * A hold is released by an ACTION, never by a timer: sending anything new, or
 * `retrySessionPrompt` on a row, releases it — the same rule the browser queue
 * always had.
 */
export async function holdSessionPrompts(
  projectId: string,
  sessionId: string,
  held: boolean,
): Promise<{ prompts: SessionPrompt[] }> {
  return unwrap(
    await backendApi.post<{ prompts: SessionPrompt[] }>(
      `/projects/${projectId}/sessions/${sessionId}/prompts/hold`,
      { held },
    ),
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
    await backendApi.patch<ProjectSession>(`/projects/${projectId}/sessions/${sessionId}`, input),
  );
}

export async function deleteProjectSession(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/sessions/${sessionId}`),
  );
}

export async function restartProjectSession(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${projectId}/sessions/${sessionId}/restart`,
      {},
    ),
  );
}

/** Manual pause: stops the running sandbox in place, resumable via start(). */
export async function stopProjectSession(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${projectId}/sessions/${sessionId}/stop`,
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
  projectId: string,
  sessionId: string,
): Promise<SessionConfigState> {
  return unwrap(
    await backendApi.get<SessionConfigState>(
      `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/config`,
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
  /** Runtime replacement outcome. Absent when an older API did not report it. */
  opencode_reload?: 'disposed' | 'restarted' | 'kept-old' | null;
  /** True when the replacement ended an incomplete turn. */
  turn_ended?: boolean | null;
  /** Why nothing was applied. Internal wording — map it, don't render it. */
  reason?: string;
  detail: string;
}

/** Server-observed boundaries for a live session-config reload. */
export type SessionReloadPhase =
  | 'checking-session'
  | 'refreshing-workspace'
  | 'compiling-config'
  | 'applying-config'
  | 'confirming-config';

/** One frame from the streamed session-config reload route. */
export type SessionReloadStreamEvent =
  | { type: 'phase'; phase: SessionReloadPhase }
  | { type: 'done'; result: SessionReloadResult }
  | {
      type: 'error';
      error: string;
      code?: string;
      status?: number;
      reason?: string;
    };

function parseSessionReloadStreamFrame(frame: string): SessionReloadStreamEvent | null {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;

  try {
    return JSON.parse(dataLines.join('\n')) as SessionReloadStreamEvent;
  } catch (cause) {
    throw new Error('reloadProjectSessionConfigStream received an invalid SSE frame', { cause });
  }
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
  projectId: string,
  sessionId: string,
  input: { refresh_repo?: boolean; force?: boolean } = {},
): Promise<SessionReloadResult> {
  return unwrap(
    await backendApi.post<SessionReloadResult>(
      `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/reload`,
      input,
      { showErrors: false },
    ),
  );
}

/**
 * Reload a running session while reporting server-observed progress.
 *
 * This runs the same reload core as {@link reloadProjectSessionConfig}. The
 * separate route preserves the existing JSON contract used by CLI clients.
 * The `applying-config` phase includes the daemon's verified runtime swap. The
 * server cannot observe its internal boot and promotion steps separately, so
 * this method does not fabricate them.
 *
 * Requires a `fetch` implementation with a readable response body. React Native
 * callers must use {@link reloadProjectSessionConfig} instead.
 */
export async function reloadProjectSessionConfigStream(
  projectId: string,
  sessionId: string,
  input: { refresh_repo?: boolean; force?: boolean },
  onEvent: (event: SessionReloadStreamEvent) => void,
  options: ApiClientOptions = {},
): Promise<SessionReloadResult> {
  const response = await backendApi.postStream(
    `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/reload-stream`,
    input,
    options,
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      reason?: string;
    } | null;
    throw new ApiError(body?.error || `Reload failed: HTTP ${response.status}`, {
      status: response.status,
      code: body?.code,
      data: body,
    });
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Reload stream is unavailable on this runtime (no response body)');

  const decoder = new TextDecoder();
  let buffer = '';
  let settled: SessionReloadResult | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const event = parseSessionReloadStreamFrame(frame);
        if (!event) continue;
        onEvent(event);
        if (event.type === 'error') {
          throw new ApiError(event.error, {
            status: event.status,
            code: event.code,
            data: { reason: event.reason },
          });
        }
        if (event.type === 'done') settled = event.result;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!settled) throw new Error('Reload stream ended without a result');
  return settled;
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
  /**
   * FULL new binding map — REPLACES the previous one. Three distinct states:
   *
   * - **omitted** — leave the session's connector scope untouched.
   * - **`null`** — CLEAR the override. Every alias the agent grants goes back to
   *   resolving the project default. This is the only way to undo an override.
   * - **`{}`** — an EXPLICIT zero-connector override: no connector at all, not
   *   even a project default. The opposite of `null`, so never send one for the
   *   other.
   */
  connector_bindings?: SessionConnectorBindingsInput | null;
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
  /**
   * Whether this session HOLDS its own connector override.
   *
   * `connector_bindings` is the server-RESOLVED map, so it looks the same for a
   * session that overrode its connectors and one that simply inherits the
   * project defaults. Read this to tell them apart: `false` means every alias
   * still resolves to the project default, and the UI must say "project
   * default" rather than "none selected". Send `connector_bindings: null` to
   * return a session to `false`.
   */
  connector_bindings_configured: boolean;
  /**
   * Whether an alias with no stored binding still falls back to the project
   * default while an override is configured. Create-time only.
   */
  connector_bindings_inherit_unbound: boolean;
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
  projectId: string,
  sessionId: string,
): Promise<SessionScope> {
  return unwrap(
    await backendApi.get<SessionScope>(
      `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/scope`,
    ),
  );
}

/**
 * Re-scope a RUNNING session. Set semantics: what you send replaces what was
 * there, and takes effect from the next prompt.
 */
export async function setProjectSessionScope(
  projectId: string,
  sessionId: string,
  scope: SessionScopeInput,
): Promise<SessionScope> {
  return unwrap(
    await backendApi.put<SessionScope>(
      `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/scope`,
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
  projectId: string,
  sessionId: string,
  opencodeModel: string,
): Promise<SessionModelChangeResult> {
  return unwrap(
    await backendApi.put<SessionModelChangeResult>(
      `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/model`,
      { opencode_model: opencodeModel },
    ),
  );
}
