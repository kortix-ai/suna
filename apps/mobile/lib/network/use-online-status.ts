/**
 * Lightweight connectivity detection without a native module.
 *
 * NetInfo / expo-network aren't installed (they'd require a native rebuild), so
 * we infer reachability by probing the API origin with a short-timeout fetch.
 * Any HTTP response — even 401/404/5xx — means the server was reached, so we're
 * online; only a thrown/aborted request counts as offline. We re-probe on app
 * foreground and on the cadence in `probe-policy` (60 s online, 10 s after a
 * failure). The state flips to offline only after two consecutive failures.
 *
 * The state is module-level so React Query's `onlineManager` can subscribe to
 * the same signal the banner shows (`subscribeOnlineStatus`).
 */

import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { API_URL } from '@/api/config';
import { nextFailureCount, nextProbeDelay, shouldShowOffline } from './probe-policy';

// Probe the API origin (strip the trailing /v1 path). Reaching ANY status =
// online; a network error or timeout = offline.
const PROBE_URL = API_URL.replace(/\/v1\/?$/, '') || API_URL;

async function probe(timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(PROBE_URL, { method: 'HEAD', signal: controller.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Optimistic (starts `true`) so the UI never flashes an offline banner during
// the first probe.
let online = true;
const listeners = new Set<(isOnline: boolean) => void>();

function publish(next: boolean) {
  if (next === online) return;
  online = next;
  listeners.forEach((listener) => listener(next));
}

/** Subscribe to reachability changes. Returns the unsubscribe function. */
export function subscribeOnlineStatus(listener: (isOnline: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOnline(): boolean {
  return online;
}

/**
 * Starts the probe loop. Returns the stop function. Runs at module scope, so
 * it does not depend on which component mounts the hook.
 */
function startProbeLoop(): () => void {
  let active = true;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, ms);
  };

  async function check() {
    if (running || !active) return;
    running = true;
    const ok = await probe();
    running = false;
    if (!active) return;
    failures = nextFailureCount(failures, ok);
    publish(!shouldShowOffline(failures));
    schedule(nextProbeDelay(ok, failures));
  }

  void check();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void check();
  });

  return () => {
    active = false;
    if (timer) clearTimeout(timer);
    sub.remove();
  };
}

let hookCount = 0;
let stopProbeLoop: (() => void) | null = null;

/** Returns whether the device can currently reach the backend. The probe loop
 *  runs while at least one component uses this hook. */
export function useOnlineStatus(): boolean {
  useEffect(() => {
    hookCount += 1;
    if (hookCount === 1) stopProbeLoop = startProbeLoop();
    return () => {
      hookCount -= 1;
      if (hookCount > 0) return;
      stopProbeLoop?.();
      stopProbeLoop = null;
      // With no probe running nothing could report recovery, so assume online
      // rather than leave React Query paused.
      publish(true);
    };
  }, []);

  return useSyncExternalStore(subscribeOnlineStatus, getOnline);
}
