import { ApiError } from '../http/api/errors';
import * as P from '../rest/projects-client';
import { setCurrentRuntime } from '../session/current-runtime';
import { getSandboxUrlForExternalId } from '../session/server-store/url-helpers';
import type { SessionRuntimeEntry } from '../session/session-runtime-registry';
/** The `/start` side of the client, shared by the single-flight map below. */
import { runtimeNotReadyMessage } from './session-shared';

/**
 * Dedupes concurrent `ensureReady()` calls that would otherwise both drive a
 * `/start` long-poll for the SAME (projectId, sessionId) — e.g. two session
 * handles for the same session (or the facade racing the React `useSession`
 * hook) both calling `ensureReady()`/`start()` before either has resolved a
 * runtime. Keyed by `${projectId}\n${sessionId}` (not the process-global
 * "active runtime" — every other handle for a DIFFERENT session gets its own
 * entry and is unaffected). Cleared on settle (success or failure) so a
 * transient failure doesn't wedge the key — the next call issues a fresh
 * `/start` instead of replaying a stale rejected promise forever.
 */
export const inFlightSessionStarts = new Map<string, Promise<SessionRuntimeEntry>>();

export function bindSessionStart(projectId: string, sessionId: string) {
  async function pollStartRuntime(readyTimeoutMs: number): Promise<SessionRuntimeEntry> {
    // Poll /start (each call long-polls up to 30s) until the runtime is
    // ready. `/start` returns `retriable: true` while the sandbox is still
    // provisioning/starting — a cold start can outlast a single long-poll —
    // so keep polling until it's ready, hits a terminal stage, or the
    // deadline. A single check would spuriously throw RUNTIME_UNAVAILABLE
    // on a slow boot, which is exactly what a backend waiting to send the
    // first turn must not do.
    const deadline = Date.now() + readyTimeoutMs;
    // Cap each server long-poll (and the inter-poll pause) to the time left
    // so the total honors readyTimeoutMs — a fixed 30s wait would overshoot
    // the deadline by up to ~30s on the final iteration.
    const remainingMs = () => Math.max(0, deadline - Date.now());
    let started = await P.startProjectSession(
      projectId,
      sessionId,
      Math.min(30_000, remainingMs()),
    );
    // Keep polling while the runtime is still coming up. A `null` result is
    // a TRANSIENT tick, not a terminal state: startProjectSession returns
    // null for a 5xx/408/429/network blip AND the create→start 404 race
    // (row not yet visible on the read path) — the exact cases a backend
    // hits calling ensureReady() right after create(). Only a resolved
    // provisioning/starting+retriable result or the deadline keeps/ends the
    // loop; ready/failed/stopped fall through to the guard below.
    while (
      Date.now() < deadline &&
      (started == null ||
        ((started.stage === 'provisioning' || started.stage === 'starting') && started.retriable))
    ) {
      await new Promise((r) => setTimeout(r, Math.min(1_000, remainingMs())));
      started = await P.startProjectSession(projectId, sessionId, Math.min(30_000, remainingMs()));
    }
    const runtimeSessionId = started?.runtime_session_id ?? started?.opencode_session_id;
    if (!started || started.stage !== 'ready' || !started.sandbox || !runtimeSessionId) {
      throw new ApiError(runtimeNotReadyMessage(started), {
        code: 'RUNTIME_UNAVAILABLE',
      });
    }
    const externalId = (started.sandbox as { external_id?: string | null }).external_id;
    if (!externalId) {
      throw new ApiError('Session sandbox has no external_id — cannot resolve its runtime URL', {
        code: 'RUNTIME_UNAVAILABLE',
      });
    }
    const runtimeUrl = getSandboxUrlForExternalId(externalId);
    // Point the app's shared runtime store at this session too, so React
    // hosts (which read the global current-runtime) keep working — but this
    // handle's own operations never read it back, only `_ready` below.
    setCurrentRuntime(runtimeUrl, externalId);
    return {
      runtimeSessionId,
      opencodeSessionId: runtimeSessionId,
      runtimeUrl,
      sandboxId: externalId,
    };
  }

  // The single-flight lives HERE, beside the /start poll it dedupes: a caller
  // that races another (this handle or a different one for the same session)
  // rides the in-flight result instead of issuing a second POST. Cleared on
  // settle so a transient failure doesn't wedge the key.
  const key = `${projectId}\n${sessionId}`;
  async function startRuntime(readyTimeoutMs: number): Promise<SessionRuntimeEntry> {
    const inFlight = inFlightSessionStarts.get(key);
    if (inFlight) return inFlight;
    const startPromise = pollStartRuntime(readyTimeoutMs);
    inFlightSessionStarts.set(key, startPromise);
    try {
      return await startPromise;
    } finally {
      if (inFlightSessionStarts.get(key) === startPromise) {
        inFlightSessionStarts.delete(key);
      }
    }
  }

  return startRuntime;
}
