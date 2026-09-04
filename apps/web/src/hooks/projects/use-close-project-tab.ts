'use client';

import { startTransition, useCallback, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import {
  useProjectSessionTabsStore,
  CUSTOMIZE_TAB_ID,
} from '@/stores/project-session-tabs-store';

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
/**
 * Where a tab id actually lives.
 *
 * `CUSTOMIZE_TAB_ID` is a sentinel, not a session: interpolating it produced
 * `/projects/<id>/sessions/customize`, which is not a route. Closing the tab
 * beside an open Customize tab therefore navigated to a 404. The prefetch
 * already skipped the sentinel; the push did not, so the two disagreed about
 * where the close was going.
 */
function tabHref(projectId: string, tabId: string): string {
  return tabId === CUSTOMIZE_TAB_ID
    ? `/projects/${projectId}/customize`
    : `/projects/${projectId}/sessions/${tabId}`;
}

export function useCloseProjectTab(projectId: string) {
  const router = useRouter();
  const pathname = usePathname();
  const closeTab = useProjectSessionTabsStore((s) => s.closeTab);
  const setOptimisticActive = useProjectSessionTabsStore(
    (s) => s.setOptimisticActive,
  );
  const openTabs = useProjectSessionTabsStore((s) => s.tabsByProject[projectId]);

  // Warm what a close lands on. Only closing the ACTIVE tab navigates, and it
  // always lands on one of two places: the neighbour the block below picks, or
  // the project root when the closed tab was the last one. A close is a
  // keystroke or an X button whose destination is only chosen at close time, so
  // it can never be an anchor — without this the push runs the RSC fetch cold
  // and a non-2xx, a redirect, or a build-id skew turns it into a full reload.
  useEffect(() => {
    const tabs = openTabs ?? [];
    if (tabs.length === 0) return;
    const match = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
    if (match?.[1] !== projectId) return;
    const idx = tabs.indexOf(match[2]);
    if (idx === -1) return;
    if (tabs.length === 1) {
      router.prefetch(`/projects/${projectId}`);
      return;
    }
    // The close picks `remaining[min(idx, remaining.length - 1)]` — the next
    // tab, or the previous one when the active tab is last.
    const neighbour = tabs[idx + 1] ?? tabs[idx - 1];
    if (!neighbour) return;
    router.prefetch(tabHref(projectId, neighbour));
  }, [openTabs, pathname, projectId, router]);

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
        // nav-contract: prefetch-only — the destination is only chosen at close
        // time. The effect above warms it.
        router.push(`/projects/${projectId}`);
        startTransition(() => closeTab(projectId, sessionId));
        return;
      }

      const nextId = remaining[Math.min(idx, remaining.length - 1)];
      setOptimisticActive(projectId, nextId);
      // nav-contract: prefetch-only — the neighbour is only chosen at close
      // time. The effect above warms it.
      router.push(tabHref(projectId, nextId));
      startTransition(() => closeTab(projectId, sessionId));
    },
    [projectId, pathname, router, closeTab, setOptimisticActive],
  );
}
