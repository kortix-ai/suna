/**
 * Backend-owned OpenCode ↔ Kortix session mapping.
 *
 * The authoritative source of a Kortix session's OpenCode root id is the
 * sandbox's own local OpenCode DB. This module lets the API resolve and pin
 * that id SERVER-SIDE so the mapping no longer depends on any client (browser,
 * CLI, cron) doing the right thing.
 *
 * `project_sessions.opencode_session_id` is the pin. The invariant:
 *   1. Honor the pin whenever it still exists in the sandbox's live session
 *      list (stable identity — never flip off it for recency/duplicates).
 *   2. If the pin is missing (fresh/rebuilt sandbox, deleted session, never
 *      set), adopt the DETERMINISTIC canonical root: the most-recently-active
 *      root (tie-broken by newest-created, then id), so every caller converges
 *      on the LIVE root — never an orphaned pre-restart root frozen mid-turn.
 *   3. If the sandbox holds no root at all, report not_ready. The sandbox
 *      daemon owns root creation during boot; the API only adopts/persists it.
 *
 * Reachability mirrors the preview proxy exactly (the path the live session's
 * OpenCode traffic already uses): resolve the per-sandbox service key + provider
 * ingress for the daemon port, and sign an X-Kortix-User-Context header so
 * the daemon authorizes the proxied call into OpenCode.
 */

import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { logger as appLogger } from '../lib/logger';
import { db } from '../shared/db';
import {
  KORTIX_USER_CONTEXT_HEADER,
  encodeKortixUserContext,
} from '../shared/kortix-user-context';
import { resolvePreviewUserContext } from '../shared/preview-ownership';
import { resolveSandboxIngress, resolveServiceKey } from '../sandbox-proxy/backend';
import {
  pickCanonicalRoot,
  resolveRootSessionId,
  type OpencodeSessionLite,
} from './opencode-session-resolver';
import { sandboxRuntimeRequestHeaders } from './sandbox-fetch';

export { pickCanonicalRoot, resolveRootSessionId, type OpencodeSessionLite };

/** Workspace directory the session's OpenCode root lives under. */
const WORKSPACE = '/workspace';
/** Daemon (kortix-sandbox-agent-server) port; it reverse-proxies to OpenCode. */
const DAEMON_PORT = 8000;

// ── Server-side reachability into the sandbox's OpenCode runtime ────────────

export async function sandboxOpencodeEndpoint(
  externalId: string,
  userId: string | undefined,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const serviceKey = await resolveServiceKey(externalId);
  if (!serviceKey) return null;
  const ingress = await resolveSandboxIngress(externalId, { port: DAEMON_PORT, transport: 'http' });
  const headers: Record<string, string> = {
    ...ingress.headers,
    'Content-Type': 'application/json',
    Authorization: `Bearer ${serviceKey}`,
  };
  const payload = await resolvePreviewUserContext(externalId, userId);
  if (payload) headers[KORTIX_USER_CONTEXT_HEADER] = encodeKortixUserContext(payload, serviceKey);
  return { url: ingress.url.replace(/\/$/, ''), headers };
}

/**
 * WHY an `unreachable` happened.
 *
 * `unreachable` collapsed FIVE distinct causes into one word: no service key,
 * a 401 unsigned context, any non-ok status, a request timeout, and a throw
 * while resolving the endpoint. The caller then parks the session with
 * `runtime_unreachable_timeout`, so an operator reading it learns only that
 * "something about the box did not answer".
 *
 * That is not hypothetical. The 401 case is already recorded in the comment
 * below as having disabled the opencode_sessions snapshot for three weeks
 * unnoticed (0 of 2804 staging sessions, 2026-08). And on 2026-09-28 a dev
 * session cycled `starting/unreachable` -> `failed/runtime_unreachable_timeout`
 * for 1447s while its daemon answered the API's own service key with
 * `200 {"daemon":"ok","opencode":"ok","runtimeReady":true}` — five candidate
 * causes, no way to tell them apart from the outside.
 *
 * The caller contract is unchanged: `reason` still says `unreachable`. This
 * only adds the WHY, so the next occurrence is self-diagnosing instead of
 * costing another investigation.
 */
export type UnreachableCause =
  /** No service key for this box — nothing was ever sent. */
  | 'no_key'
  /** The daemon refused the signed context (401). Never transient. */
  | 'unsigned_context'
  /** The daemon answered, with a status we cannot use. Carries the code. */
  | `http_${number}`
  /** The request exceeded LIST_TIMEOUT_MS, or the connection failed. */
  | 'timeout_or_network'
  /** Resolving the endpoint itself threw (provider API, rate limit, gone). */
  | 'endpoint_error';

/**
 * Which of the two throw-shaped causes this error is.
 *
 * An AbortError/TimeoutError is the request budget — the box is reachable but
 * slow. Anything else happened before or around the request (resolving the
 * endpoint, the provider API, DNS, a refused connection) — the box could not
 * be addressed at all. "Slow" and "gone" need different responses, so they
 * must not share a word.
 */
export function unreachableCauseForThrow(err: unknown): UnreachableCause {
  const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return aborted ? 'timeout_or_network' : 'endpoint_error';
}

export type ListResult =
  | { ok: true; sessions: OpencodeSessionLite[] }
  | {
      ok: false;
      reason: 'no_key' | 'not_ready' | 'unreachable';
      bootPhase?: string;
      /** Present on every `unreachable`. See `UnreachableCause`. */
      cause?: UnreachableCause;
    };

/** The daemon names its boot phase on every 503 — see the daemon's boot-phase.ts. */
export const BOOT_PHASE_HEADER = 'x-kortix-boot-phase';

/** List the sandbox's OpenCode sessions (server-side, via the signed proxy). */
export async function listSandboxOpencodeSessions(
  externalId: string,
  userId: string | undefined,
): Promise<ListResult> {
  try {
    // Endpoint resolution itself can throw (provider preview-link API errors,
    // rate limits, archived/deleted sandboxes). Keep it INSIDE the try so any
    // failure degrades to a clean `unreachable` instead of rejecting up the
    // call stack and 500ing the caller (e.g. the session list title-sync).
    const ep = await sandboxOpencodeEndpoint(externalId, userId);
    if (!ep) return { ok: false, reason: 'no_key', cause: 'no_key' };
    const res = await fetch(
      `${ep.url}/session?directory=${encodeURIComponent(WORKSPACE)}`,
      // Fail FAST: a healthy daemon answers this list in <300ms; an 8s budget
      // only ever bought riding out a wedged first connection to a freshly
      // restored microVM (residual CH RX stall), and it costs chat-ready
      // latency 1:1 because the FE's ensure retry can't start until this
      // returns. Observed: 8s 'unreachable' tails on warm forks; 3s + the
      // FE's ~1.6s backoff retry beats hanging.
      {
        method: 'GET',
        headers: sandboxRuntimeRequestHeaders(ep.headers),
        signal: AbortSignal.timeout(3_000),
      },
    );
    // 503 = daemon up but OpenCode/repo not ready yet — distinct from a hard
    // failure so callers can retry rather than treat it as "empty".
    if (res.status === 503) {
      const bootPhase = res.headers.get(BOOT_PHASE_HEADER)?.trim() || undefined;
      return { ok: false, reason: 'not_ready', ...(bootPhase ? { bootPhase } : {}) };
    }
    // A 401 here is NEVER transient and never the sandbox's fault: the daemon
    // rejects every non-`/kortix/*` path without a valid X-Kortix-User-Context,
    // and this call only carries one when `userId` was supplied. Folding that
    // into a silent `unreachable` is what let a userId-less caller disable the
    // opencode_sessions snapshot for three weeks unnoticed (0 of 2804 staging
    // sessions in 2026-08). Name it in the log; the caller contract is unchanged.
    if (res.status === 401) {
      appLogger.warn('[opencode-mapping] daemon refused the session list (unsigned context)', {
        externalId,
        hasUserId: Boolean(userId),
      });
      return { ok: false, reason: 'unreachable', cause: 'unsigned_context' };
    }
    if (!res.ok) return { ok: false, reason: 'unreachable', cause: `http_${res.status}` };
    const data = (await res.json()) as unknown;
    const sessions = Array.isArray(data) ? (data as OpencodeSessionLite[]) : [];
    return { ok: true, sessions };
  } catch (err) {
    return { ok: false, reason: 'unreachable', cause: unreachableCauseForThrow(err) };
  }
}

export type EnsureReason =
  | 'unchanged'
  | 'healed'
  | 'not_ready'
  | 'unreachable';

export interface EnsureResult {
  pin: string | null;
  changed: boolean;
  reason: EnsureReason;
  sessions?: OpencodeSessionLite[];
  /** Daemon-reported boot phase behind a `not_ready` (opaque; compare for equality). */
  bootPhase?: string;
  /** WHY, when `reason` is `unreachable`. See `UnreachableCause`. */
  cause?: UnreachableCause;
}

/**
 * The single authoritative writer of `opencode_session_id`. Lists the sandbox's
 * OpenCode sessions, resolves the canonical root, and persists it when it
 * differs from the stored pin. Best-effort on unreachability: returns the
 * current pin unchanged so a transient sandbox blip never clobbers a good
 * mapping.
 */
export async function ensureOpencodeSessionPin(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  externalId: string;
  userId: string | undefined;
  currentPin: string | null;
}): Promise<EnsureResult> {
  const { projectId, sessionId, accountId, externalId, userId, currentPin } = input;

  const listed = await listSandboxOpencodeSessions(externalId, userId);
  if (!listed.ok) {
    return {
      pin: currentPin,
      changed: false,
      reason: listed.reason === 'not_ready' ? 'not_ready' : 'unreachable',
      ...(listed.bootPhase ? { bootPhase: listed.bootPhase } : {}),
      // Carry the WHY to the open, which is the only place a human sees it.
      ...(listed.cause ? { cause: listed.cause } : {}),
    };
  }

  let sessions = listed.sessions;
  let resolved = resolveRootSessionId({ pinnedRootId: currentPin, sessions });

  if (!resolved) {
    return { pin: currentPin, changed: false, reason: 'not_ready', sessions };
  }

  if (resolved === currentPin) {
    return { pin: resolved, changed: false, reason: 'unchanged', sessions };
  }

  await db
    .update(projectSessions)
    .set({ opencodeSessionId: resolved, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.sessionId, sessionId),
        eq(projectSessions.projectId, projectId),
        eq(projectSessions.accountId, accountId),
      ),
    );

  return { pin: resolved, changed: true, reason: 'healed', sessions };
}
