import type { OpencodeClient, SessionHandle } from '@kortix/sdk';

import type { Auth } from './api/auth.ts';
import type { ApiClient } from './api/client.ts';
import { kortixFromAuth, withKortixScope } from './api/sdk.ts';
import type { ProjectSession } from './api/types.ts';

/**
 * The PRINT-FREE core of "get me a session I can talk to".
 *
 * Everything here is shared by the CLI commands (which print their own
 * messages around it) and by `attach-opencode.ts` (which is a library an
 * embedder — e.g. `apps/tui` — calls with its renderer suspended). Nothing in
 * this module may write to stdout/stderr: it reports failure by throwing
 * `SessionRuntimeError`, and progress through callbacks.
 */

/** Session states `connect` restarts before it can attach. */
export const DORMANT_SESSION_STATUSES: ReadonlySet<ProjectSession['status']> = new Set([
  'stopped',
  'completed',
  'failed',
]);

export type SessionRuntimeFailure =
  /** The row is not `running` and the caller did not allow a restart. */
  | 'not-running'
  /** A Kortix API call threw; `cause` holds the original error. */
  | 'api'
  /** `/start` reported `failed` / `stopped` after the boot grace. */
  | 'start-failed'
  /** `/start` never reached `ready` within the poll budget. */
  | 'timeout'
  /** `SessionHandle.ensureReady()` threw; `cause` holds the original error. */
  | 'ensure-ready';

export class SessionRuntimeError extends Error {
  readonly kind: SessionRuntimeFailure;
  override readonly cause?: unknown;

  constructor(kind: SessionRuntimeFailure, message: string, cause?: unknown) {
    super(message);
    this.name = 'SessionRuntimeError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** A session whose sandbox is up and whose OpenCode runtime answered. */
export interface SessionRuntime {
  /** Kortix session row as read before any restart (status may be stale). */
  session: ProjectSession;
  /** Auth used for every scoped SDK call. */
  auth: Auth;
  /** Session-scoped SDK handle. */
  handle: SessionHandle;
  /** Typed OpenCode REST client bound to this session's runtime. */
  runtime: OpencodeClient;
  /** SDK-resolved runtime URL used by the local `opencode attach` adapter. */
  runtimeUrl: string;
  /** Canonical OpenCode session id resolved by `/start`. */
  opencodeSessionId: string;
}

export interface WaitForSessionReadyOptions {
  /** Poll attempts (default 75). */
  attempts?: number;
  /** Delay between attempts in ms (default 4000). */
  intervalMs?: number;
  /** Test seam for the delay. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive the canonical `/start` lifecycle endpoint until the runtime is ready —
 * row status alone can say "running" before OpenCode actually answers. Sandbox
 * boots take minutes, not seconds: up to 75 x 4s ~= 5 min, matching the API's
 * own provisioning ceiling.
 */
export async function waitForSessionReady(
  client: ApiClient,
  projectId: string,
  sessionId: string,
  options: WaitForSessionReadyOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 75;
  const intervalMs = options.intervalMs ?? 4000;
  const sleep = options.sleep ?? defaultSleep;

  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(intervalMs);
    let stage: string;
    let reason: string | undefined;
    try {
      const start = await client.post<{
        stage: 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';
        reason?: string;
      }>(`/projects/${projectId}/sessions/${sessionId}/start`, {});
      stage = start.stage;
      reason = start.reason;
    } catch (err) {
      throw new SessionRuntimeError('api', (err as Error).message, err);
    }
    if (stage === 'ready') return;
    // A just-restarted session can report `stopped` for a few polls before the
    // provisioner picks it up — only treat it as terminal once that grace is
    // clearly over.
    if (stage === 'stopped' && i < 5) continue;
    if (stage === 'failed' || stage === 'stopped') {
      throw new SessionRuntimeError(
        'start-failed',
        `Session did not start (${stage}${reason ? `: ${reason}` : ''}).`,
      );
    }
  }
  throw new SessionRuntimeError('timeout', 'Timed out waiting for the sandbox to start.');
}

/** What to do when the session row is not `running`. */
export type NotRunningPolicy =
  /** Throw `not-running` (what the chat/connect commands do today). */
  | 'fail'
  /** Attach anyway — for reads that do not need the agent (e.g. `sessions cp`). */
  | 'ignore'
  /** Restart a dormant session, then poll `/start` until it is ready. */
  | 'start';

export interface ResolveSessionRuntimeOptions {
  auth: Auth;
  client: ApiClient;
  projectId: string;
  /** Already-fetched Kortix row — callers locate it themselves. */
  session: ProjectSession;
  /** Default `'fail'`. */
  onNotRunning?: NotRunningPolicy;
  /** Called once, before the restart + `/start` poll, when it is about to run. */
  onStarting?: (session: ProjectSession) => void;
  wait?: WaitForSessionReadyOptions;
}

/**
 * Take a located session row to a live runtime: enforce/repair its state, then
 * `ensureReady()` the SDK handle. Throws `SessionRuntimeError`; prints nothing.
 */
export async function resolveSessionRuntime(
  options: ResolveSessionRuntimeOptions,
): Promise<SessionRuntime> {
  const { auth, client, projectId, session } = options;
  const policy = options.onNotRunning ?? 'fail';

  if (session.status !== 'running' && policy !== 'ignore') {
    if (policy === 'fail') {
      throw new SessionRuntimeError(
        'not-running',
        `Session ${session.session_id} is ${session.status}, not running.`,
      );
    }
    options.onStarting?.(session);
    if (DORMANT_SESSION_STATUSES.has(session.status)) {
      try {
        await client.post(`/projects/${projectId}/sessions/${session.session_id}/restart`, {});
      } catch (err) {
        throw new SessionRuntimeError('api', (err as Error).message, err);
      }
    }
    await waitForSessionReady(client, projectId, session.session_id, options.wait);
  }

  const handle = kortixFromAuth(auth).session(projectId, session.session_id);
  let ready: Awaited<ReturnType<SessionHandle['ensureReady']>>;
  try {
    ready = await withKortixScope(auth, () => handle.ensureReady());
  } catch (err) {
    throw new SessionRuntimeError('ensure-ready', (err as Error).message, err);
  }
  return {
    session,
    auth,
    handle,
    runtime: handle.runtime,
    runtimeUrl: ready.runtimeUrl,
    opencodeSessionId: ready.opencodeSessionId,
  };
}

/** Fetch one Kortix session row, failing as a `SessionRuntimeError`. */
export async function fetchProjectSession(
  client: ApiClient,
  projectId: string,
  sessionId: string,
): Promise<ProjectSession> {
  try {
    return await client.get<ProjectSession>(`/projects/${projectId}/sessions/${sessionId}`);
  } catch (err) {
    throw new SessionRuntimeError('api', (err as Error).message, err);
  }
}
