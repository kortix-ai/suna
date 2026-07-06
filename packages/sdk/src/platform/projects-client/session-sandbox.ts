// Session sandbox — runtime sandbox row + the session-open (/start) flow.

import { backendApi } from '../api-client';
import { setSessionRuntime } from '../../state/session-runtime-registry';
import { getSandboxUrlForExternalId } from '../../state/server-store/url-helpers';

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
  provider: 'daytona' | 'platinum' | 'local_docker' | 'justavps';
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
  /** Immutable project-session agent bound at session creation. */
  agent_name: string;
  /** Whether polling /start again can make progress (false = terminal). */
  retriable: boolean;
  sandbox: ProjectSessionSandbox | null;
  opencode_session_id: string | null;
  /**
   * Relative proxy path for this session's OpenCode runtime (port 8000), composed
   * against the configured backendUrl. The server owns the proxy scheme; the SDK
   * consumes this opaquely (never builds `/p/<id>/<port>` itself). Absent until the
   * box has an external_id — `useSession` falls back to deriving it from
   * `sandbox.external_id` when missing.
   */
  runtime_url?: string | null;
  reason?: string;
}

export class SessionStartError extends Error {
  status?: number;
  code?: string;
  terminal: boolean;

  constructor(message: string, options: { status?: number; code?: string; terminal: boolean }) {
    super(message);
    this.name = 'SessionStartError';
    this.status = options.status;
    this.code = options.code;
    this.terminal = options.terminal;
  }
}

export function isSessionStartError(error: unknown): error is SessionStartError {
  return error instanceof Error && error.name === 'SessionStartError';
}

function classifySessionStartFailure(error?: Error): SessionStartError | null {
  const apiError = error as
    | (Error & { status?: number; code?: string; details?: { code?: string; error?: string } })
    | undefined;
  const status = apiError?.status;
  const code = apiError?.code ?? apiError?.details?.code ?? apiError?.details?.error;
  const message = apiError?.message || 'Unable to start this session';

  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return new SessionStartError(message, { status, code, terminal: true });
  }

  return null;
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
    // Keep toasts quiet here. Terminal client errors are rendered by the host;
    // transient transport/server failures still yield null so polling can recover.
    { showErrors: false },
  );
  if (!response.success || !response.data) {
    const terminal = classifySessionStartFailure(response.error);
    if (terminal) throw terminal;
    return null;
  }
  const result = response.data;
  // Populate the shared session-runtime registry the instant a session goes
  // ready, regardless of WHICH caller drove this /start (the facade's
  // `ensureReady()` or the React `useSession` hook — both call this one
  // function). Every other handle for the same session id — a fresh
  // `kortix.session(pid, sid)` created for a one-off poll, e.g. — can then
  // adopt this entry instead of throwing SessionNotReadyError or re-POSTing.
  const externalId = result.sandbox?.external_id;
  if (result.stage === 'ready' && externalId && result.opencode_session_id) {
    setSessionRuntime(projectId, sessionId, {
      opencodeSessionId: result.opencode_session_id,
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
  return ['session-start', projectId, sessionId] as const;
}
