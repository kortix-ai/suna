/**
 * useSandboxReachability — lightweight poller that tracks whether the
 * sandbox's /kortix/health endpoint is currently reachable.
 *
 * Mirrors the web's sandbox-connection-store reachability tracking, but
 * scoped to a single hook call: the caller passes the sandboxUrl and we
 * ping every 10s, returning `{ reachable, downSince }` so the consumer can
 * render an "Unreachable · {elapsed}" pill identical to the web's
 * ReconnectPill (apps/web/src/components/dashboard/connecting-screen.tsx).
 */

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { checkInstanceHealth } from '@/lib/platform/client';

const POLL_INTERVAL_MS = 10_000;
const INITIAL_GRACE_MS = 3_000;

export interface SandboxReachability {
  /** True once we've completed at least one probe. */
  checked: boolean;
  /** Last known reachability. `true` = /kortix/health returned 200. */
  reachable: boolean;
  /** ms timestamp when the sandbox first became unreachable. `null` when up. */
  downSince: number | null;
}

export function useSandboxReachability(sandboxUrl: string | undefined): SandboxReachability {
  const [state, setState] = useState<SandboxReachability>({
    checked: false,
    reachable: true,
    downSince: null,
  });
  const mountedRef = useRef(true);
  const downSinceRef = useRef<number | null>(null);

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

    const probe = async () => {
      const version = await checkInstanceHealth(sandboxUrl);
      if (cancelled || !mountedRef.current) return;
      const isReachable = version !== null;
      setState((prev) => {
        let downSince = prev.downSince;
        if (isReachable) {
          downSince = null;
        } else if (!downSince) {
          // Transitioned from reachable → unreachable
          downSince = Date.now();
        }
        downSinceRef.current = downSince;
        return { checked: true, reachable: isReachable, downSince };
      });
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
