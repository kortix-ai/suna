/**
 * useSandboxReachability — lightweight poller that tracks what the session's
 * computer is doing, from its /kortix/health endpoint.
 *
 * The caller passes the sandboxUrl and we probe every 10s, returning
 * `{ reachable, downSince, connection }`: `connection` is the SDK's vocabulary
 * (`connectionFromHealth`), so the pill says "Waking computer" for a parked or
 * booting computer and "Can't reach computer" only when a dial failed.
 *
 * Each probe is one sample, folded through the SDK's `settleSessionConnection`:
 * good news lands at once, bad news must persist `CONNECTION_FAULT_GRACE_MS`.
 * Drawing every sample made the pill flap Connecting → Can't reach → gone on a
 * computer that never went away (KRTX-606). An open event stream is the
 * runtime answering, so it reads live whatever a probe concluded.
 */

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  connectionFromHealth,
  getSessionHealth,
  INITIAL_SETTLED_CONNECTION,
  settleSessionConnection,
  type SessionConnection,
  type SettledConnection,
} from '@kortix/sdk';
import { useStreamHealthStore } from '@/lib/opencode/stream-health';
import { recordRuntimeCapabilities } from '@/lib/opencode/runtime-capabilities';

const POLL_INTERVAL_MS = 10_000;
const INITIAL_GRACE_MS = 3_000;
/** A box mid-turn answers slowly. 3s timed out on loaded boxes and read as a fault. */
const PROBE_TIMEOUT_MS = 10_000;

function streamIsOpen(): boolean {
  return useStreamHealthStore.getState().health.phase === 'connected';
}

/**
 * One probe of the session's computer, read in the SDK's connection vocabulary
 * (`getSessionHealth` + `connectionFromHealth`). It used to count anything but
 * a 200 as down, so a parked computer (the control plane answers for it) and a
 * booting one (the runtime answers `starting`) both read "Unreachable". Only a
 * failed dial, or no answer at all, is unreachable now. The SDK's fetch carries
 * the bearer token the session proxy requires.
 */
async function probeSandboxConnection(sandboxUrl: string): Promise<SessionConnection> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const result = await getSessionHealth(sandboxUrl.replace(/\/$/, ''), { signal: controller.signal });
    // What the runtime serves rides on the same answer: no second poller (E1).
    recordRuntimeCapabilities(sandboxUrl, result.health?.capabilities);
    return connectionFromHealth(result);
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timeout);
  }
}

export interface SandboxReachability {
  /** True once we've completed at least one probe. */
  checked: boolean;
  /** Last known reachability: the runtime answered ready (or nothing is known yet). */
  reachable: boolean;
  /** ms timestamp when the computer stopped being ready. `null` when up. */
  downSince: number | null;
  /** What the last probe said, in the SDK's connection vocabulary. */
  connection: SessionConnection;
}

export function useSandboxReachability(sandboxUrl: string | undefined): SandboxReachability {
  const [state, setState] = useState<SandboxReachability>({
    checked: false,
    reachable: true,
    downSince: null,
    connection: 'unknown',
  });
  const mountedRef = useRef(true);
  const settledRef = useRef<SettledConnection>(INITIAL_SETTLED_CONNECTION);
  const streamOpen = useStreamHealthStore((s) => s.health.phase === 'connected');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sandboxUrl) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // A different computer: what we knew about the last one says nothing.
    settledRef.current = INITIAL_SETTLED_CONNECTION;

    const apply = (observed: SessionConnection) => {
      if (cancelled || !mountedRef.current) return;
      settledRef.current = settleSessionConnection(settledRef.current, observed, Date.now());
      const connection = settledRef.current.connection;
      const isReachable = connection === 'live' || connection === 'unknown';
      setState((prev) => {
        let downSince = prev.downSince;
        if (isReachable) {
          downSince = null;
        } else if (!downSince) {
          // Transitioned from reachable → unreachable
          downSince = settledRef.current.faultSinceMs ?? Date.now();
        }
        // Keep the same object when nothing changed so consumers skip the
        // re-render on every 10 s probe.
        if (
          prev.checked &&
          prev.reachable === isReachable &&
          prev.downSince === downSince &&
          prev.connection === connection
        ) {
          return prev;
        }
        return { checked: true, reachable: isReachable, downSince, connection };
      });
    };

    const probe = async () => {
      const observed = await probeSandboxConnection(sandboxUrl);
      apply(streamIsOpen() ? 'live' : observed);
    };

    // Give the app a grace period after mount before the first probe so we
    // don't flash "Unreachable" while the container is still warming up.
    const initialDelay = setTimeout(probe, INITIAL_GRACE_MS);
    timer = setInterval(probe, POLL_INTERVAL_MS);

    // Re-probe immediately when the app returns to foreground — the sandbox
    // may have stopped while the app was backgrounded.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') probe();
    });

    return () => {
      cancelled = true;
      clearTimeout(initialDelay);
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [sandboxUrl]);

  // The stream opening is the runtime answering: clear the pill now, not on
  // the next 10s probe.
  useEffect(() => {
    if (!streamOpen || !sandboxUrl) return;
    settledRef.current = settleSessionConnection(settledRef.current, 'live', Date.now());
    setState((prev) =>
      prev.reachable && prev.connection === 'live' && prev.downSince === null
        ? prev
        : { checked: true, reachable: true, downSince: null, connection: 'live' },
    );
  }, [streamOpen, sandboxUrl]);

  return state;
}

/**
 * Human-readable elapsed seconds/minutes since `since` (ms epoch), updated
 * every second. Returns null when `since` is null. Matches web's
 * `useElapsedTime` output format so the pill reads identically.
 */
export function useElapsedSince(since: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);

  if (since === null) return null;
  const seconds = Math.floor((now - since) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
