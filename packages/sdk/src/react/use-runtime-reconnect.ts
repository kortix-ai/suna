'use client';

import { useEffect, useRef } from 'react';
import { getSupabaseAccessToken } from '../core/http/auth';
import { getSessionHealth, isRuntimeReady, type SessionHealthResponse } from '../core/session';
import {
  incrementSandboxFail,
  markInitialCheckDone,
  resetForServerSwitch,
  resetSandboxFail,
  setRuntimeHealth,
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
// "sandbox active" and "Runtime healthy" AND the enable-gate for the opencode
// session list — so every extra interval is visible dead time after the backend
// is already ready. 150ms keeps the healthy flip (and the session-list start)
// tracking actual daemon readiness tightly; the health probe is a cheap GET.
export const POLL_FAILING = 150;
export const POLL_UNREACHABLE = 5_000; // 5s when confirmed unreachable

export const CHECK_TIMEOUT = 20_000;

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
  | { kind: 'failure'; immediateOffline: boolean }
  | { kind: 'healthy'; health: SessionHealthResponse | null };

export interface ProbeResultLike {
  status: number;
  ok: boolean;
  health: SessionHealthResponse | null;
  body: string;
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
    // Runtime still booting behind an already-live sandbox proxy — this is
    // progress, not failure: reset the fail counter and report "connected"
    // (sandbox is up) with `healthy: false` (Runtime isn't yet).
    return { kind: 'booting', health: result.health };
  }

  if (!result.ok) {
    return { kind: 'failure', immediateOffline: isImmediateOfflineSignal(result.status, result.body) };
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
  // Initial "connecting" phase (sandbox just went active, runtime still
  // booting) — poll fast so the runtime appears the moment it's healthy
  // instead of waiting out a long interval.
  return POLL_FAILING;
}

/**
 * useRuntimeReconnect — monitors the active session's runtime reachability
 * mid-session (see `use-session` / runtime hooks for how this fits alongside the
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

      const url = useServerStore.getState().getActiveServerUrl();
      if (!url) {
        scheduleNext();
        return;
      }

      // Don't fire health checks until auth is ready — avoids naked requests
      // that return synthetic 401s and cause false "unreachable" status.
      const token = await getSupabaseAccessToken();
      if (!token) {
        scheduleNext();
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let immediateOffline = false;
      let failed = false;

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
            setRuntimeHealth(
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
            break;
          }
          case 'healthy': {
            resetSandboxFail();
            setSandboxStatus('connected');
            setRuntimeHealth(
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
      } finally {
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
        // polling and `healthy` never flips, so live session subscriptions
        // never start and a fresh session's first turn stays invisible until
        // a manual reload.
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
