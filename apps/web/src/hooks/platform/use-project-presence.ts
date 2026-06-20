'use client';

import { useEffect } from 'react';

import { backendApi } from '@/lib/api-client';

/** How often to tell the backend "this project tab is still open." The warm pool
 *  keeps a spare parked while presence is fresh and reaps it ~3× this after the
 *  last beat (see POOL_PRESENCE_STALE_MS in warm-pool.ts). */
const HEARTBEAT_MS = 45_000;

/**
 * Warm-pool presence: while a project page is open + visible, heartbeat the
 * backend so it keeps a pre-warmed spare ready for the user's next session; on
 * close/navigate-away, beacon a "leave" so the spare is reaped immediately.
 *
 * This is what makes warm spares track *projects open right now* instead of the
 * old "every project touched in the last 6h" age rule — see warm-pool.ts.
 * No-op server-side unless the warm pool is enabled and the member can launch
 * sessions, so it's safe to mount unconditionally on the project/session page.
 */
export function useProjectPresence(projectId: string | null | undefined): void {
  useEffect(() => {
    if (!projectId) return;
    const base = `/projects/${projectId}/presence`;

    const ping = () => {
      // While the tab is hidden we stop beating; presence goes stale and the
      // spare is reaped after the staleness window. A quick tab-switch (back
      // within that window) never loses the spare; a long-hidden tab does.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void backendApi.post(base).catch(() => {});
    };
    const leave = () => {
      // keepalive lets the request survive the page unload.
      void backendApi.post(`${base}/leave`, undefined, { keepalive: true }).catch(() => {});
    };

    ping();
    const interval = setInterval(ping, HEARTBEAT_MS);
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') ping();
    };
    document.addEventListener('visibilitychange', onVisible);
    // pagehide fires on real close / hard navigation (more reliable than
    // beforeunload, and bfcache-safe) → drop presence + reap now.
    window.addEventListener('pagehide', leave);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', leave);
      // SPA navigation away from the project page (unmount) is also a "leave".
      leave();
    };
  }, [projectId]);
}
