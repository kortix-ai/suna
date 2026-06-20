/**
 * Lightweight connectivity detection without a native module.
 *
 * NetInfo / expo-network aren't installed (they'd require a native rebuild), so
 * we infer reachability by probing the API origin with a short-timeout fetch.
 * Any HTTP response — even 401/404/5xx — means the server was reached, so we're
 * online; only a thrown/aborted request counts as offline. We re-probe on app
 * foreground and on a backoff interval (faster while offline so recovery shows
 * quickly).
 */

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { API_URL } from '@/api/config';

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

const ONLINE_INTERVAL = 20_000;
const OFFLINE_INTERVAL = 5_000;

/** Returns whether the device can currently reach the backend. Optimistic
 *  (starts `true`) so the UI never flashes an offline banner during the first
 *  probe. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    let running = false;

    const schedule = (ms: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(check, ms);
    };

    async function check() {
      if (running || !mountedRef.current) return;
      running = true;
      const ok = await probe();
      running = false;
      if (!mountedRef.current) return;
      setOnline(ok);
      schedule(ok ? ONLINE_INTERVAL : OFFLINE_INTERVAL);
    }

    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      sub.remove();
    };
  }, []);

  return online;
}
