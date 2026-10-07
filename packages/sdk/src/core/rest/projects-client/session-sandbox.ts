// Session sandbox — runtime sandbox row + the session-open (/start) flow.

import { backendApi } from "../../http/api-client";
import { isSessionFresh } from "../../http/fresh-sessions";
import { setSessionRuntime } from "../../session/session-runtime-registry";
import { getSandboxUrlForExternalId } from "../../session/server-store/url-helpers";
import type { ProjectSession } from "./sessions";

// ---------------------------------------------------------------------------
// Session sandbox — runtime row in `kortix.session_sandboxes`. Separate from
// the legacy /instances sandbox table (`kortix.sandboxes`); no billing or
// team-membership coupling. Access gated by `project_members` only.
// ---------------------------------------------------------------------------

export type ProjectSessionSandboxStatus =
  "provisioning" | "active" | "stopped" | "error" | "archived";

export interface ProjectSessionSandbox {
  sandbox_id: string;
  session_id: string;
  project_id: string;
  account_id: string;
  provider: "daytona" | "platinum" | "e2b";
  external_id: string | null;
  base_url: string | null;
  status: ProjectSessionSandboxStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SessionStartStage =
  "provisioning" | "starting" | "ready" | "stopped" | "failed";

export interface SessionStartFailure {
  category:
    | 'provider-capacity'
    | 'git-auth'
    | 'sandbox-provider'
    | 'unsupported-secret-delivery'
    | 'invalid-secret-boundary-policy'
    | 'snapshot-too-large';
  message: string;
  /** A user action can retry. Automatic polling must still stop. */
  retryable: boolean;
  /**
   * WHY this negative was claimed: which check produced it, when, what the
   * provider said, how many consecutive attempts it counts, and when the
   * SERVER re-attempts by itself (`next_retry_at`).
   *
   * Absent on payloads from an API older than the session-open envelope.
   */
  evidence?: {
    check: string;
    observed_at: string | null;
    error: string | null;
    attempts: number;
    next_retry_at: string | null;
  };
}

export interface SessionStartResult {
  /** Coarse lifecycle stage to render + poll on. */
  stage: SessionStartStage;
  /** Immutable project-session agent bound at session creation. */
  agent_name: string;
  /** Whether polling /start again can make progress (false = terminal). */
  retriable: boolean;
  sandbox: ProjectSessionSandbox | null;
  /** Canonical runtime root pin, resolved server-side once the box is up. Served by APIs since W4. */
  runtime_session_id?: string | null;
  /** @deprecated The pre-W4 name of `runtime_session_id`. Same value. */
  opencode_session_id: string | null;
  /** Stable terminal failure. Provider-specific diagnostics stay internal. */
  failure?: SessionStartFailure | null;
  /**
   * Relative proxy path for this session's OpenCode runtime (port 8000), composed
   * against the configured backendUrl. The server owns the proxy scheme; the SDK
   * consumes this opaquely (never builds `/p/<id>/<port>` itself). Absent until the
   * box has an external_id — `useSession` falls back to deriving it from
   * `sandbox.external_id` when missing.
   */
  runtime_url?: string | null;
  reason?: string;
  /**
   * What the session's runtime serves, as the daemon lists it in
   * `GET /kortix/health`. Present with `stage: 'ready'` on APIs that read it;
   * `useSession` then knows the list before its own first health probe.
   */
  capabilities?: string[];

  // ── Session-open envelope. Every field describes THIS call, not the row's
  // accumulated history. Optional: an older API omits them entirely.
  /** ONE clock for the whole answer. */
  observed_at?: string;
  /**
   * What the server DID on this call. There is deliberately no
   * `replayed_stamp`: an answer no live check supports is a defect, not a
   * state. Before this existed, `/start` could return `stage:"failed"` from a
   * stamp written hours earlier without contacting a provider.
   */
  action?:
    | "inspected"
    | "checked_provider"
    | "resumed"
    | "provisioned"
    | "restored"
    | "reconciled"
    | "awaited_wake"
    | "cooling_down";
  /** Where the box is in its boot, and whether anything is driving it now. */
  boot?: {
    phase: "provisioning" | "resuming" | "booting" | "ready" | "parked" | "failed";
    since: string | null;
    /**
     * Is a provider operation running for this session right now? `false` on a
     * `starting` payload means the server is waiting out a retry cooldown, not
     * that a box is being started.
     */
    actively_starting: boolean;
  };
  /**
   * What the server checked on this call. `known: false` means NOT CHECKED —
   * never "checked and found nothing". The sandbox row's own
   * `metadata.healthStatus: "unknown"` conflates those two; this does not.
   */
  observation?: {
    provider: { known: boolean; status: string | null; checked_at: string | null };
    runtime: {
      known: boolean;
      state: "ready" | "booting" | "unreachable" | null;
      boot_phase: string | null;
      checked_at: string | null;
    };
  };
  /** The transport the server selected for the runtime. Only `rest` today. */
  runtime_transport?: 'rest';
}

/**
 * Convert a server-reported running inventory row into an optimistic readiness
 * seed. The session route renders it immediately, then its normal `/start`
 * query revalidates the server state.
 */
export function projectSessionStartSeed(
  session: ProjectSession,
): SessionStartResult | null {
  if (
    session.status !== "running" ||
    !session.sandbox_id ||
    !session.sandbox_provider ||
    !session.sandbox_url ||
    !(session.runtime_session_id ?? session.opencode_session_id)
  ) {
    return null;
  }
  const runtimeSessionId = session.runtime_session_id ?? session.opencode_session_id;
  const externalId = session.sandbox_url.match(/\/p\/([^/]+)\//)?.[1];
  if (!externalId) return null;
  return {
    stage: "ready",
    agent_name: session.agent_name ?? "default",
    retriable: true,
    sandbox: {
      sandbox_id: session.sandbox_id,
      session_id: session.session_id,
      project_id: session.project_id,
      account_id: session.account_id,
      provider: session.sandbox_provider,
      external_id: externalId,
      base_url: session.sandbox_url,
      status: "active",
      config: {},
      metadata: session.metadata,
      last_used_at: session.updated_at,
      created_at: session.created_at,
      updated_at: session.updated_at,
    },
    runtime_session_id: runtimeSessionId,
    opencode_session_id: runtimeSessionId,
    runtime_url: session.sandbox_url,
  };
}

export class SessionStartError extends Error {
  status?: number;
  code?: string;
  terminal: boolean;

  constructor(message: string, options: { status?: number; code?: string; terminal: boolean },
  ) {
    super(message);
    this.name = "SessionStartError";
    this.status = options.status;
    this.code = options.code;
    this.terminal = options.terminal;
  }
}

export function isSessionStartError(error: unknown,
): error is SessionStartError {
  return error instanceof Error && error.name === "SessionStartError";
}

function classifySessionStartFailure(error?: Error): SessionStartError | null {
  const apiError = error as
    | (Error & { status?: number; code?: string; details?: { code?: string; error?: string };
      })
    | undefined;
  const status = apiError?.status;
  const code = apiError?.code ?? apiError?.details?.code ?? apiError?.details?.error;
  const message = apiError?.message || "Unable to start this session";

  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return new SessionStartError(message, { status, code, terminal: true });
  }

  return null;
}

// Numeric input remains supported for existing SDK consumers.
type SessionStartOptions = number | {
    /** Server-side long-poll budget in milliseconds. */
    waitMs?: number;
    /**
   * Telemetry only. A session created before a repository replacement starts,
   * runs the project's current config release and converges without it.
   */
    repositoryMode?: "previous";
    /**
     * A keep-alive poll of a session the tab already shows as ready. The API
     * reports a box the user stopped, or the idle policy parked, as `stopped`
     * instead of waking it. Leave it off for an explicit open or resume.
     */
    keepStopped?: boolean;
  };

function postSessionStart(projectId: string, sessionId: string, options?: SessionStartOptions) {
  const waitMs = typeof options === "number" ? options : options?.waitMs;
  const repositoryMode = typeof options === "number" ? undefined : options?.repositoryMode;
  const search = new URLSearchParams();
  if (waitMs && waitMs > 0) search.set("wait_ms", String(Math.floor(waitMs)));
  if (repositoryMode) search.set("repository_mode", repositoryMode);
  if (typeof options === "object" && options?.keepStopped) search.set("keep_stopped", "1");
  const qs = search.size > 0 ? `?${search.toString()}` : "";
  return backendApi.post<SessionStartResult>(
    `/projects/${projectId}/sessions/${sessionId}/start${qs}`,
    {},
    // Keep toasts quiet here. Terminal client errors are rendered by the host;
    // transient transport/server failures still yield null so polling can recover.
    { showErrors: false },
  );
}

/**
 * THE session-open call. Idempotently provisions/resumes the sandbox and resolves
 * the OpenCode pin server-side, returning ONE readiness payload to poll until
 * stage='ready'.
 */
export async function startProjectSession(
  projectId: string,
  sessionId: string,
  options?: SessionStartOptions,
): Promise<SessionStartResult | null> {
  const response = await postSessionStart(projectId, sessionId, options);
  if (!response.success || !response.data) {
    const terminal = classifySessionStartFailure(response.error);
    // A 404 for a session minted in THIS tab is the optimistic create-vs-start
    // race: `useNewProjectSession` fires this /start before its background
    // create POST has landed, so the row doesn't exist yet. Yield null so the
    // poll keeps going; a 404 for any other session stays terminal.
    if (terminal && !(terminal.status === 404 && isSessionFresh(sessionId))) throw terminal;
    return null;
  }
  return recordReadyRuntime(projectId, sessionId, response.data);
}

/**
 * {@link startProjectSession}, but every failed request rejects with the API
 * error itself (`status`, `code`, and a 402's billing `detail` intact) instead
 * of yielding `null`. For a host that counts transient failures and shows one
 * error, or opens an upgrade prompt on a 402.
 */
export async function startProjectSessionOrThrow(
  projectId: string,
  sessionId: string,
  options?: SessionStartOptions,
): Promise<SessionStartResult> {
  const response = await postSessionStart(projectId, sessionId, options);
  if (!response.success || !response.data) throw response.error ?? new Error("Unable to start this session");
  return recordReadyRuntime(projectId, sessionId, response.data);
}

function recordReadyRuntime(projectId: string, sessionId: string, result: SessionStartResult): SessionStartResult {
  // Populate the shared session-runtime registry the instant a session goes
  // ready, regardless of WHICH caller drove this /start (the facade's
  // `ensureReady()` or the React `useSession` hook — both call this one
  // function). Every other handle for the same session id — a fresh
  // `kortix.session(pid, sid)` created for a one-off poll, e.g. — can then
  // adopt this entry instead of throwing SessionNotReadyError or re-POSTing.
  const externalId = result.sandbox?.external_id;
  const runtimeSessionId = result.runtime_session_id ?? result.opencode_session_id;
  if (result.stage === "ready" && externalId && runtimeSessionId) {
    setSessionRuntime(projectId, sessionId, {
      runtimeSessionId,
      opencodeSessionId: runtimeSessionId,
      runtimeUrl: getSandboxUrlForExternalId(externalId),
      sandboxId: externalId,
    });
  }
  return result;
}

/**
 * Stable React Query key for the session-open (`/start`) poll. Shared by the
 * session page's useQuery AND every create→navigate site that prefetches it, so
 * the keys can never drift — a mismatch would issue a SECOND `/start` POST
 * instead of adopting the in-flight one.
 */
export function sessionStartKey(projectId: string, sessionId: string) {
  return ["session-start", projectId, sessionId] as const;
}
