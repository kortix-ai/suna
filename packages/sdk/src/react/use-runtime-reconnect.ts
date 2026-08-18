'use client';

import { useEffect, useRef } from 'react';
import { getSupabaseAccessToken } from '../core/http/auth';
import {
  getSessionHealth,
  isRuntimeReady,
  type ProxyHop,
  type SessionHealthResponse,
} from '../core/session';
import {
  incrementSandboxFail,
  markInitialCheckDone,
  resetForServerSwitch,
  resetSandboxFail,
  setOpenCodeHealth,
  setSandboxStatus,
  setSandboxVersion,
  useSandboxConnectionStore,
  type SandboxConnectionStatus,
} from '../browser/stores/sandbox-connection-store';
import { useServerStore } from '../browser/stores/server-store';

/**
 * Number of consecutive failures before marking as unreachable
 * when this is the FIRST connection (never been connected).
 * Set high enough to ride through transient proxy startup delays.
 */
export const FAIL_THRESHOLD_FIRST = 5;

/**
 * For reconnection (was connected, then failed) — require two consecutive
 * failures before declaring the instance unreachable. The first miss drops
 * into a lightweight reconnecting state so transient timeouts don't kick the
 * user to an offline/error UI.
 */
export const FAIL_THRESHOLD_RECONNECT = 2;

/** Interval between health checks (ms) */
export const POLL_CONNECTED = 30_000; // 30s when healthy
// Tight cadence while a sandbox is booting/unhealthy. This is the gate between
// "sandbox active" and "OpenCode healthy" AND the enable-gate for the opencode
// session list — so every extra interval is visible dead time after the backend
// is already ready. 150ms keeps the healthy flip (and the session-list start)
// tracking actual daemon readiness tightly; the health probe is a cheap GET.
export const POLL_FAILING = 150;
export const POLL_UNREACHABLE = 5_000; // 5s when confirmed unreachable

export const CHECK_TIMEOUT = 20_000;

/**
 * How recently a live SSE event must have arrived to veto a failed probe.
 * An event that just came over the wire is stronger evidence of reachability
 * than a probe timeout: a box saturated by a heavy turn (PDF rendering, asset
 * builds) can miss the probe deadline while streaming that same turn's events.
 * Without the veto, two such misses flipped the UI to "Waking this session
 * up…", tore down the SSE stream (gated on status === 'connected'), and queued
 * every send — against a runtime that was demonstrably up and mid-turn.
 */
export const RUNTIME_EVIDENCE_FRESH_MS = 15_000;

/**
 * Whether a failed health probe should be discarded because live runtime
 * events prove reachability. Pure — see RUNTIME_EVIDENCE_FRESH_MS.
 */
export function shouldIgnoreProbeFailure(
  lastRuntimeEvidenceAt: number | null,
  now: number,
): boolean {
  if (lastRuntimeEvidenceAt === null) return false;
  return now - lastRuntimeEvidenceAt < RUNTIME_EVIDENCE_FRESH_MS;
}

/**
 * Whether a failed probe is evidence that the RUNTIME is unreachable, and may
 * therefore move this session toward "unreachable".
 *
 * TWO independent facts can clear a failure, and they cover disjoint failures.
 *
 * 1. WHICH HOP the proxy blamed (`X-Kortix-Proxy-Hop`). Two of the four say
 *    nothing about the runtime:
 *
 *      - `control_plane` — the platform answered from the session row without
 *        ever dialling the box (`503 sandbox not ready (status: stopped)`). An
 *        answer is not silence; counting it drove a session to "unreachable"
 *        while `/start` was still resuming it.
 *      - `upstream_port` — the user's own dev server on an app port is down.
 *        That is their process, not our runtime, and it must never render
 *        "Waking".
 *
 * 2. WHETHER SSE FRAMES ARE STILL ARRIVING. The hop cannot answer this and
 *    never will: the health probe addresses the daemon port, so every failure
 *    it can observe is `daemon` (the proxy reached the box, the runtime did
 *    not answer), `provider_ingress`, or — for a `CHECK_TIMEOUT` abort — no hop
 *    at all. All three count. On a box saturated by a heavy turn that is the
 *    2026-08-17 incident verbatim: two missed probes flip `sandboxStatus` to
 *    `unreachable`, `useOpenCodeEventStream` (gated on `=== 'connected'`) tears
 *    the live stream down, and the transcript freezes mid-turn on a runtime
 *    that is provably up — it is delivering the frames. A frame is a fact from
 *    the runtime itself, not an inference, and it outranks a probe that timed
 *    out behind it.
 *
 * An UNATTRIBUTED failure with no fresh frames still counts. A network error,
 * a `CHECK_TIMEOUT` abort, or a response from something that is not our proxy
 * carries no hop, and refusing to count those would leave a browser that lost
 * its connection reading "connected" forever — the poller's only job.
 */
export function shouldCountProbeFailure(input: {
  hop: ProxyHop | null;
  lastRuntimeEvidenceAt: number | null;
  nowMs: number;
}): boolean {
  if (input.hop === 'control_plane' || input.hop === 'upstream_port') return false;
  if (shouldIgnoreProbeFailure(input.lastRuntimeEvidenceAt, input.nowMs)) return false;
  return true;
}

/** Statuses whose HTTP response itself signals "nothing is home" — no threshold needed. */
export function isImmediateOfflineStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Whether a resolved-but-failed probe response should be treated as an
 * immediate "unreachable" signal rather than counted against the normal
 * failure threshold — either a proxy-dead HTTP status, or a body that
 * explicitly says no service answered.
 */
export function isImmediateOfflineSignal(status: number, body: string): boolean {
  return isImmediateOfflineStatus(status) || /no service is responding|not reachable/i.test(body);
}

/**
 * The result of interpreting one resolved `getSessionHealth` response. Pure —
 * given the same `SessionHealthResult` shape it always classifies the same
 * way, independent of the store or the network. A thrown/aborted probe
 * (network error, `CHECK_TIMEOUT` abort) never reaches this function — the
 * hook folds those into `{ kind: 'failure', immediateOffline: false }` itself,
 * since there is no HTTP status/body to classify.
 */
export type ProbeOutcome =
  | { kind: 'auth-error' }
  | { kind: 'booting'; health: SessionHealthResponse | null }
  | {
      kind: 'failure';
      immediateOffline: boolean;
      /** Which proxy hop produced it — see `shouldCountProbeFailure`. */
      hop: ProxyHop | null;
      upstreamStatus: number | null;
    }
  | { kind: 'healthy'; health: SessionHealthResponse | null };

export interface ProbeResultLike {
  status: number;
  ok: boolean;
  health: SessionHealthResponse | null;
  body: string;
  /**
   * OPTIONAL, and it has to stay that way. This interface is published on
   * `@kortix/sdk/react` and appears only in INPUT position — constructing one
   * is the only way an external caller reaches `classifyProbeResult`. The two
   * fields below landed after 0.12.8, so requiring them would break every such
   * caller at compile time for a value the SDK's own probe always supplies.
   */
  hop?: ProxyHop | null;
  upstreamStatus?: number | null;
}

export function classifyProbeResult(result: ProbeResultLike): ProbeOutcome {
  if (result.status === 401 || result.status === 403) {
    // Treat auth errors like any other failure — respect the threshold
    // instead of immediately marking unreachable. During transitions (e.g.
    // provisioning → dashboard), the proxy may briefly return 401 before auth
    // propagates.
    return { kind: 'auth-error' };
  }

  if (result.status === 503) {
    // OpenCode still booting behind an already-live sandbox proxy — this is
    // progress, not failure: reset the fail counter and report "connected"
    // (sandbox is up) with `healthy: false` (OpenCode isn't yet).
    return { kind: 'booting', health: result.health };
  }

  if (!result.ok) {
    return {
      kind: 'failure',
      immediateOffline: isImmediateOfflineSignal(result.status, result.body),
      hop: result.hop ?? null,
      upstreamStatus: result.upstreamStatus ?? null,
    };
  }

  return { kind: 'healthy', health: result.health };
}

/**
 * Threshold counting — the one piece of state this machine actually needs to
 * decide a transition. `failCount` is the count AFTER the current failure has
 * been recorded (matches `incrementSandboxFail()` semantics: increment, then
 * read). Returns the next status, or `null` for "no status change" (still
 * below threshold on a first-ever connection, which stays in whatever status
 * it already had — normally "connecting").
 */
export function computeFailureStatus(
  failCount: number,
  wasConnected: boolean,
  immediateOffline: boolean,
): SandboxConnectionStatus | null {
  if (immediateOffline) return 'unreachable';

  const threshold = wasConnected ? FAIL_THRESHOLD_RECONNECT : FAIL_THRESHOLD_FIRST;
  if (failCount >= threshold) return 'unreachable';
  if (wasConnected) return 'connecting';
  return null;
}

/**
 * Next poll interval, purely a function of the current store status/healthy
 * pair — fast while anything is unresolved or unhealthy, slow once truly
 * settled into "connected and healthy".
 */
export function nextPollDelay(status: SandboxConnectionStatus, healthy: boolean | null): number {
  if (status === 'connected' && healthy === false) return POLL_FAILING;
  if (status === 'connected') return POLL_CONNECTED;
  if (status === 'unreachable') return POLL_UNREACHABLE;
  // Initial "connecting" phase (sandbox just went active, opencode still
  // booting) — poll fast so the runtime appears the moment it's healthy
  // instead of waiting out a long interval.
  return POLL_FAILING;
}

/**
 * useRuntimeReconnect — monitors the active session's runtime reachability
 * mid-session (see `react/opencode.ts` for how this fits alongside the
 * server-truth boot readiness and the SSE heartbeat).
 *
 * Probes `getSessionHealth` (the SDK's `/kortix/health`) and maps the result
 * into the shared `sandbox-connection-store`. Behaviour:
 *   - On first failure, immediately switches to fast polling.
 *   - If the user was previously connected, the first failure moves to
 *     "connecting" and the second consecutive failure marks unreachable.
 *   - If it's the first connection, requires FAIL_THRESHOLD_FIRST failures.
 *
 * The transition logic itself (`classifyProbeResult`, `computeFailureStatus`,
 * `nextPollDelay`) is pure and exported above — this hook is thin glue that
 * wires those decisions to a `setTimeout` loop and the store's action
 * functions, since the repo has no harness to render-test a hook directly.
 */
export function useRuntimeReconnect() {
  const manualRetryNonce = useSandboxConnectionStore((state) => state.manualRetryNonce);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isMountRef = useRef(true);

  useEffect(() => {
    // Reading the generation inside the effect makes the dependency explicit:
    // each manual retry tears down the in-flight probe and starts a fresh one.
    void manualRetryNonce;
    const isFirstMount = isMountRef.current;
    isMountRef.current = false;

    if (isFirstMount) {
      // Full reset — clears wasConnected, failCount, status, everything.
      resetForServerSwitch();
    }

    let alive = true;

    async function check() {
      if (!alive) return;

      let url: string | null;
      let token: string | null;
      try {
        url = useServerStore.getState().getActiveServerUrl();
        if (!url) {
          scheduleNext();
          return;
        }

        // Don't fire health checks until auth is ready — avoids naked requests
        // that return synthetic 401s and cause false "unreachable" status.
        token = await getSupabaseAccessToken();
        if (!token) {
          scheduleNext();
          return;
        }
      } catch {
        // `getActiveServerUrl()` and `getSupabaseAccessToken()` are host
        // config/auth lookups, not network calls guarded by the `try` below
        // — a throw here (e.g. `createClient()`'s "Missing Supabase browser
        // environment variables" during an env hydration race) used to
        // escape `check()` uncaught. `check()` runs detached (fire-and-forget
        // from the effect, and from this same `setTimeout` callback), so an
        // uncaught rejection silently ended the poll loop: `scheduleNext()`
        // never ran again, `healthy` stayed whatever it last was, and
        // "Waking this session up…" (gated on `runtimeReady`, which reads
        // this store) stayed up forever — recoverable only by a hard reload
        // remounting this effect. Retry next tick exactly like the `!token`
        // early-return above, instead of dying.
        if (alive) scheduleNext();
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let immediateOffline = false;
      let failed = false;
      // Which hop the proxy blamed, when it blamed one. Stays null for a thrown
      // probe — there is no response to read it from.
      let hop: ProxyHop | null = null;

      try {
        const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
        const result = await getSessionHealth(url, { signal: controller.signal });
        clearTimeout(timer);

        if (!alive) return;

        const outcome = classifyProbeResult(result);
        switch (outcome.kind) {
          case 'auth-error': {
            failed = true;
            immediateOffline = false;
            break;
          }
          case 'booting': {
            resetSandboxFail();
            setSandboxStatus('connected');
            setOpenCodeHealth(
              false,
              outcome.health?.version,
              outcome.health?.boot_error ?? outcome.health?.message ?? outcome.health?.reason ?? null,
            );
            if (outcome.health?.version) {
              setSandboxVersion(outcome.health.version);
            }
            break;
          }
          case 'failure': {
            failed = true;
            immediateOffline = outcome.immediateOffline;
            hop = outcome.hop;
            break;
          }
          case 'healthy': {
            resetSandboxFail();
            setSandboxStatus('connected');
            setOpenCodeHealth(
              isRuntimeReady(outcome.health),
              outcome.health?.version,
              outcome.health?.boot_error ?? outcome.health?.message ?? outcome.health?.reason ?? null,
            );
            if (outcome.health?.version) {
              setSandboxVersion(outcome.health.version);
            }
            break;
          }
        }
      } catch {
        // Network error or `CHECK_TIMEOUT` abort — no HTTP status/body to
        // classify, so this always counts as a plain (non-immediate) failure;
        // the threshold decides whether it flips the status.
        if (!alive) return;
        failed = true;
        immediateOffline = false;
        hop = null;
      } finally {
        // A failure the proxy attributed to a hop that is not the runtime (our
        // own control-plane answer, or the user's app port), or one raised
        // while live SSE frames are still arriving, is discarded here rather
        // than in `computeFailureStatus` — so it moves neither the counter nor
        // the status, an "immediate offline" 502/503 included.
        if (
          failed &&
          !shouldCountProbeFailure({
            hop,
            lastRuntimeEvidenceAt: useSandboxConnectionStore.getState().lastRuntimeEvidenceAt,
            nowMs: Date.now(),
          })
        ) {
          failed = false;
        }
        if (failed) {
          incrementSandboxFail();
          if (immediateOffline) {
            setSandboxStatus('unreachable');
          } else {
            const { failCount, wasConnected } = useSandboxConnectionStore.getState();
            const nextStatus = computeFailureStatus(failCount, wasConnected, immediateOffline);
            if (nextStatus) setSandboxStatus(nextStatus);
          }
        }

        // Reschedule from finally so EVERY path re-arms the poll loop —
        // notably the "booting" branch returns early; without this it stops
        // polling and `healthy` never flips, so useSessionSync and the SSE
        // (both gated on healthy) never subscribe and a fresh session's first
        // turn stays invisible until a manual reload.
        if (alive) {
          markInitialCheckDone();
          scheduleNext();
        }
      }
    }

    function scheduleNext() {
      if (!alive) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      const { status, healthy } = useSandboxConnectionStore.getState();
      timerRef.current = setTimeout(check, nextPollDelay(status, healthy));
    }

    check();

    return () => {
      alive = false;
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [manualRetryNonce]);
}
