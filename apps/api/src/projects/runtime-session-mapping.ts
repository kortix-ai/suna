/**
 * Backend-owned runtime session ↔ Kortix session mapping.
 *
 * The authoritative source of a Kortix session's runtime root id is the box:
 * kortixd names the root thread on `/kortix/health`
 * (`harness.session.root_thread_id`). This module lets the API resolve and pin
 * that id SERVER-SIDE so the mapping does not depend on any client (browser,
 * CLI, cron) doing the right thing.
 *
 * `project_sessions.runtime_session_id` is the pin. The invariant:
 *   1. When the box names the same root as the pin, keep the pin.
 *   2. When the box names another root (fresh or rebuilt box, pin never set),
 *      store that root as the pin.
 *   3. When the box names no root yet, report not_ready. The daemon owns root
 *      creation during boot; the API only adopts and persists it.
 *
 * Reachability mirrors the preview proxy exactly (the path the live session's
 * runtime traffic already uses): resolve the per-sandbox service key + provider
 * ingress for the daemon port, and sign an X-Kortix-User-Context header so
 * the daemon authorizes the proxied call into the runtime.
 */

import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { BOOT_PHASE_HEADER, RUNTIME_LOG_CAPABILITY } from '@kortix/api-contract/runtime-relay';
import { logger as appLogger } from '../lib/logger';
import { db } from '../shared/db';
import {
  KORTIX_USER_CONTEXT_HEADER,
  encodeKortixUserContext,
} from '../shared/kortix-user-context';
import { resolvePreviewUserContext } from '../shared/preview-ownership';
import { resolveSandboxIngress, resolveServiceKey } from '../sandbox-proxy/backend';
import { sandboxRuntimeRequestHeaders } from './sandbox-fetch';
import { runtimeCapabilities, runtimeVerbPaths } from './session-lifecycle/runtime-fetch';


/** Daemon (kortixd, kortix-sandbox-agent-server) port; it serves the runtime routes. */
const DAEMON_PORT = 8000;

// ── Server-side reachability into the sandbox's runtime ─────────────────────

export async function sandboxRuntimeEndpoint(
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
 * below as having disabled the runtime_sessions snapshot for three weeks
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
  | {
      ok: false;
      reason: 'no_key' | 'not_ready' | 'unreachable';
      bootPhase?: string;
      /** Present on every `unreachable`. See `UnreachableCause`. */
      cause?: UnreachableCause;
      /** `Server` header of whatever answered — names the provider edge. */
      responder?: string;
      /** First 120 chars of the error body, whitespace-collapsed. */
      detail?: string;
      /** The daemon's `boot_error` when its runtime is down: this boot is over. See `finishedBootError`. */
      bootError?: string;
    };

export { BOOT_PHASE_HEADER };

/**
 * The daemon's `boot_error` when the runtime start it reports has FINISHED and
 * failed: the harness is `down` and names an error. pi clears the error when a
 * start begins and keeps the box up after a failed one ("the box stays
 * observable"), so nothing in the box tries again; only a restart can. A start
 * still running reports `starting`, and an error beside a running harness (a
 * repo clone, the audit spool) is not a failed start. Null otherwise.
 */
export function finishedBootError(health: unknown): string | null {
  if (!health || typeof health !== 'object') return null;
  const body = health as { boot_error?: unknown; harness?: { state?: unknown } | null };
  if (body.harness?.state !== 'down' || typeof body.boot_error !== 'string') return null;
  const error = body.boot_error.replace(/\s+/g, ' ').trim().slice(0, 500);
  return error || null;
}

/**
 * The session's root, from a box that serves its own session log (`runtime.log.v1`): its health
 * names the root thread once the runtime started (`harness.session.root_thread_id`). Ready means
 * the runtime answers a signed read. Not `harness.ready`,
 * which also waits for the config release proof and would hold `/start` longer than before.
 */
export async function readRuntimeRoot(
  ep: { url: string; headers: Record<string, string> },
): Promise<{ ok: true; root: string } | Extract<ListResult, { ok: false }>> {
  try {
    const read = (path: string) =>
      fetch(`${ep.url}${path}`, {
        method: 'GET',
        headers: sandboxRuntimeRequestHeaders(ep.headers),
        signal: AbortSignal.timeout(3_000),
      });
    // `/kortix/health` names the root and checks no signature. `/pending` checks it, so a box whose
    // service key drifted is refused here with the daemon's reason (the `bad_signature` repair).
    const [health, signed] = await Promise.all([read('/kortix/health'), read(runtimeVerbPaths.pending)]);
    const refused = [signed, health].find((res) => !res.ok && res.status !== 503);
    const notReady = [signed, health].find((res) => res.status === 503);
    if (refused) {
      const responder = refused.headers.get('server')?.trim().slice(0, 40) || null;
      const snippet = (await refused.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120);
      await Promise.all([signed, health].filter((res) => res !== refused).map((res) => res.body?.cancel().catch(() => {})));
      return {
        ok: false,
        reason: 'unreachable',
        cause: refused.status === 401 ? 'unsigned_context' : `http_${refused.status}`,
        ...(responder ? { responder } : {}),
        ...(snippet ? { detail: snippet } : {}),
      };
    }
    await signed.body?.cancel().catch(() => {});
    // The daemon answers `/kortix/health` 200 even while its runtime is down, and
    // that body is the only place a failed start is named.
    const body = health.ok
      ? ((await health.json().catch(() => null)) as {
          harness?: { state?: unknown; session?: { root_thread_id?: unknown } };
        } | null)
      : null;
    if (!health.ok) await health.body?.cancel().catch(() => {});
    const bootError = finishedBootError(body);
    if (notReady) {
      const bootPhase = notReady.headers.get(BOOT_PHASE_HEADER)?.trim() || undefined;
      return { ok: false, reason: 'not_ready', ...(bootPhase ? { bootPhase } : {}), ...(bootError ? { bootError } : {}) };
    }
    const root = body?.harness?.session?.root_thread_id;
    if (body?.harness?.state !== 'ok' || typeof root !== 'string' || !root) {
      return { ok: false, reason: 'not_ready', ...(bootError ? { bootError } : {}) };
    }
    return { ok: true, root };
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
  /** Daemon-reported boot phase behind a `not_ready` (opaque; compare for equality). */
  bootPhase?: string;
  /** WHY, when `reason` is `unreachable`. See `UnreachableCause`. */
  cause?: UnreachableCause;
  /** `Server` header of whatever answered. */
  responder?: string;
  /** First 120 chars of the error body. */
  detail?: string;
  /** Behind a `not_ready`: the daemon's runtime start failed and is over (`finishedBootError`). */
  bootError?: string;
}

/**
 * The single authoritative writer of `runtime_session_id`. Reads the root the
 * box names on its health and persists it when it differs from the stored pin.
 * Best-effort on unreachability: returns the current pin unchanged so a
 * transient sandbox blip never clobbers a good mapping.
 */
export async function ensureRuntimeSessionPin(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  externalId: string;
  userId: string | undefined;
  currentPin: string | null;
  /** Pre-resolved daemon endpoint. When given, the reads below skip their
   *  own (provider-hitting) resolution. */
  endpoint?: { url: string; headers: Record<string, string> };
}): Promise<EnsureResult> {
  const { projectId, sessionId, accountId, externalId, userId, currentPin } = input;

  // The box names its root on its health (`runtime.log.v1`). A daemon that answers without that
  // capability is below the runtime floor: it keeps its pin, and the open holds it until it runs
  // the current daemon (session-open/runtime-floor.ts). An unanswered capability read falls
  // through to the health read, which says why the box did not answer.
  const endpoint = () => (input.endpoint ? Promise.resolve(input.endpoint) : sandboxRuntimeEndpoint(externalId, userId).catch(() => null));
  const capabilities = await runtimeCapabilities(externalId, endpoint);
  if (capabilities && !capabilities.includes(RUNTIME_LOG_CAPABILITY)) {
    return { pin: currentPin, changed: false, reason: 'unchanged' };
  }
  const ep = await endpoint();
  const noKey: Extract<ListResult, { ok: false }> = { ok: false, reason: 'unreachable', cause: 'no_key' };
  const named = ep ? await readRuntimeRoot(ep) : noKey;
  if (!named.ok) {
    return {
      pin: currentPin,
      changed: false,
      reason: named.reason === 'not_ready' ? 'not_ready' : 'unreachable',
      ...(named.cause ? { cause: named.cause } : {}),
      ...(named.responder ? { responder: named.responder } : {}),
      ...(named.detail ? { detail: named.detail } : {}),
      ...(named.reason === 'not_ready' && named.bootError ? { bootError: named.bootError } : {}),
    };
  }
  return healPin({ projectId, sessionId, accountId }, currentPin, named.root);
}

/** Store `resolved` as the session's pin when it differs from `currentPin`. */
async function healPin(
  row: { projectId: string; sessionId: string; accountId: string },
  currentPin: string | null,
  resolved: string,
): Promise<EnsureResult> {
  if (resolved === currentPin) {
    return { pin: resolved, changed: false, reason: 'unchanged' };
  }

  await db
    .update(projectSessions)
    .set({ runtimeSessionId: resolved, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.sessionId, row.sessionId),
        eq(projectSessions.projectId, row.projectId),
        eq(projectSessions.accountId, row.accountId),
      ),
    );

  return { pin: resolved, changed: true, reason: 'healed' };
}
