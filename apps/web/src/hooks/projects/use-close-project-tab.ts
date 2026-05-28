'use client';

import { startTransition, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';

/**
 * Close a project session tab and slide focus to its nearest neighbor.
 *
 * Used by both the tab-bar X button and the Ctrl+W shortcut so they behave
 * identically. The smoothness of a tab close hinges on three things, all
 * handled here:
 *
 *  1. **Optimistic active.** Pin the next tab as "active" in the store the
 *     instant the close fires. `usePathname` only flips after Next.js
 *     commits the route, so without this pin the highlight blanks for a
 *     frame between the old tab disappearing and the new URL settling.
 *
 *  2. **Navigate first.** Push the next URL *before* mutating the tab list
 *     — that lets Next.js start route resolution while the old page is
 *     still mounted, so the URL change tends to commit in the same React
 *     render as the tab-bar removal.
 *
 *  3. **Close in a transition.** Wrap `closeTab` in `startTransition` so
 *     the tab-bar drop is marked non-urgent. React will batch it with the
 *     pending route transition instead of unmounting the closed tab a
 *     frame ahead of the page swap.
 *
 * Stale-event guard: if the requested tab is no longer in the store (rapid
 * close events where `pathname` lags the store), this returns immediately
 * instead of computing `idx === -1` and routing to `/sessions/undefined`.
 */
export function useCloseProjectTab(projectId: string) {
  const router = useRouter();
  const pathname = usePathname();
  const closeTab = useProjectSessionTabsStore((s) => s.closeTab);
  const setOptimisticActive = useProjectSessionTabsStore(
    (s) => s.setOptimisticActive,
  );

  return useCallback(
    (sessionId: string) => {
      const tabs =
        useProjectSessionTabsStore.getState().tabsByProject[projectId] ?? [];
      const idx = tabs.indexOf(sessionId);
      // Already gone (duplicate event, stale snapshot from a previous close
      // whose `router.push` hasn't flushed yet). Bail before idx underflow.
      if (idx === -1) return;

      const isActive =
        pathname?.startsWith(`/projects/${projectId}/sessions/${sessionId}`) ??
        false;

      if (!isActive) {
        // Closing a background tab — no navigation, just drop it.
        closeTab(projectId, sessionId);
        return;
      }

      const remaining = tabs.filter((id) => id !== sessionId);
      if (remaining.length === 0) {
        router.push(`/projects/${projectId}`);
        startTransition(() => closeTab(projectId, sessionId));
        return;
      }

      const nextId = remaining[Math.min(idx, remaining.length - 1)];
      setOptimisticActive(projectId, nextId);
      router.push(`/projects/${projectId}/sessions/${nextId}`);
      startTransition(() => closeTab(projectId, sessionId));
    },
    [projectId, pathname, router, closeTab, setOptimisticActive],
  );
}
