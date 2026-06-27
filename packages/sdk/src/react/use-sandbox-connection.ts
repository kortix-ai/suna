'use client';

/**
 * useSandboxConnection — monitors the ACTIVE server's runtime reachability and
 * drives `useSandboxConnectionStore`. This is the gate the whole reactive-chat
 * surface depends on: `useSessionSync` and the SSE event stream
 * (`OpenCodeEventStreamProvider`) only subscribe once `healthy === true`.
 *
 * Mount this ONCE under the active session (after `switchToSessionSandboxAsync`
 * has pointed the server-store at the session's sandbox). It polls
 * `GET /kortix/health` on the active runtime via the SDK's `getSessionHealth`
 * — fast while booting/unhealthy, slow once connected — and applies failure
 * thresholds so transient blips don't flap the UI offline.
 *
 * Ported from apps/web's `hooks/platform/use-sandbox-connection.ts`, minus the
 * dead `GET /kortix/ports` probe (the rewritten agent server serves no such
 * route — port mappings come from the platform API; see `../session/health`).
 */

import { useEffect, useRef } from 'react';
import { getAuthToken } from '../platform/auth';
import { getSessionHealth, isRuntimeReady } from '../session/health';
import {
  incrementSandboxFail,
  markInitialCheckDone,
  resetForServerSwitch,
  resetSandboxFail,
  setOpenCodeHealth,
  setSandboxStatus,
  setSandboxVersion,
  useSandboxConnectionStore,
} from '../state/sandbox-connection-store';
import { useServerStore } from '../state/server-store';

/** Consecutive failures tolerated on a FIRST connection (rides proxy warmup). */
const FAIL_THRESHOLD_FIRST = 5;
/** Consecutive failures tolerated when reconnecting (was healthy, then blipped). */
const FAIL_THRESHOLD_RECONNECT = 2;

const POLL_CONNECTED = 30_000; // healthy → relaxed
const POLL_FAILING = 150; // booting/unhealthy → tight, tracks daemon readiness
const POLL_UNREACHABLE = 5_000; // confirmed down → back off

function isImmediateOfflineStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export function useSandboxConnection(): void {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const serverVersion = useServerStore((s) => s.serverVersion);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountRef = useRef(true);
  const prevServerVersionRef = useRef(serverVersion);

  useEffect(() => {
    const isFirstMount = isMountRef.current;
    isMountRef.current = false;
    const isServerSwitch = serverVersion !== prevServerVersionRef.current;
    prevServerVersionRef.current = serverVersion;

    // Each instance starts from a clean slate (clears wasConnected/failCount/…).
    if (isFirstMount || isServerSwitch) {
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

      // Don't probe before auth is ready — a naked request returns a synthetic
      // 401 and would flap the connection to a false "unreachable".
      const token = await getAuthToken();
      if (!token) {
        scheduleNext();
        return;
      }

      try {
        const { status, ok, health, body } = await getSessionHealth(url, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!alive) return;

        if (status === 401 || status === 403) {
          // Treat auth blips like any other failure — respect the threshold.
          throw new Error(`Auth error: ${status}`);
        }

        if (status === 503) {
          // Runtime reachable but OpenCode still booting — connected, not ready.
          resetSandboxFail();
          setSandboxStatus('connected');
          setOpenCodeHealth(
            false,
            health?.version,
            health?.boot_error ?? health?.message ?? health?.reason ?? null,
          );
          if (health?.version) setSandboxVersion(health.version);
          return;
        }

        if (!ok) {
          const offlineSignal =
            isImmediateOfflineStatus(status) ||
            /no service is responding|not reachable/i.test(body);
          const error = new Error(
            `Sandbox health check failed: ${status}`,
          ) as Error & { immediateOffline?: boolean };
          error.immediateOffline = offlineSignal;
          throw error;
        }

        resetSandboxFail();
        setSandboxStatus('connected');
        setOpenCodeHealth(
          isRuntimeReady(health),
          health?.version,
          health?.boot_error ?? health?.message ?? health?.reason ?? null,
        );
        if (health?.version) setSandboxVersion(health.version);
      } catch (error) {
        if (!alive) return;
        if ((error as { immediateOffline?: boolean } | undefined)?.immediateOffline) {
          incrementSandboxFail();
          setSandboxStatus('unreachable');
        } else {
          incrementSandboxFail();
          const { failCount, wasConnected } = useSandboxConnectionStore.getState();
          const threshold = wasConnected
            ? FAIL_THRESHOLD_RECONNECT
            : FAIL_THRESHOLD_FIRST;
          if (failCount >= threshold) {
            setSandboxStatus('unreachable');
          } else if (wasConnected) {
            setSandboxStatus('connecting');
          }
        }
      } finally {
        if (alive) markInitialCheckDone();
      }

      scheduleNext();
    }

    function scheduleNext() {
      if (!alive) return;
      if (timerRef.current) clearTimeout(timerRef.current);

      const { status, healthy } = useSandboxConnectionStore.getState();
      let delay: number;
      if (status === 'connected' && healthy === false) {
        delay = POLL_FAILING;
      } else if (status === 'connected') {
        delay = POLL_CONNECTED;
      } else if (status === 'unreachable') {
        delay = POLL_UNREACHABLE;
      } else {
        delay = POLL_FAILING; // initial "connecting" — poll fast until ready
      }
      timerRef.current = setTimeout(check, delay);
    }

    check();

    return () => {
      alive = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeServerId, serverVersion]);
}
