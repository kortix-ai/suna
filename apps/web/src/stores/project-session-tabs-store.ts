'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Per-project open-session tabs.
 *
 * A "tab" here = a project session_id currently surfaced in the top bar.
 * Tabs persist across reloads so the user comes back to the same set of
 * sessions they had open. Cap at MAX so the bar can't grow unbounded.
 *
 * Scope: the project shell only. The legacy tab-store (instances) is a
 * different beast and we intentionally don't reuse it.
 */

const MAX_TABS_PER_PROJECT = 8;
const MAX_RECENTLY_CLOSED = 16;

/**
 * Sentinel tab id for the project's Customize surface. Customize lives in the
 * same ordered tab list as sessions so it behaves like any other tab — it
 * opens where you put it, keeps its position, and closes with Cmd/Ctrl+W.
 * The literal can't collide with a session_id (those are UUIDs).
 */
export const CUSTOMIZE_TAB_ID = 'customize';

interface State {
  /**
   * projectId → ordered list of open tab ids. Entries are session_ids, plus
   * the CUSTOMIZE_TAB_ID sentinel when the Customize tab is open.
   */
  tabsByProject: Record<string, string[]>;
  /** projectId → stack of recently-closed tab ids (most recent last) */
  recentlyClosedByProject: Record<string, string[]>;
  /**
   * Transient override of which tab is "active" in the bar. Set the moment
   * a close-and-switch transition starts so the highlight moves before
   * Next.js commits the new URL — `usePathname` only flips after the route
   * has resolved. Cleared once the real URL catches up. Not persisted.
   */
  optimisticActiveByProject: Record<string, string | null>;
}

const STORAGE_KEY = 'kortix.project-session-tabs';

/**
 * Cap how many projects we retain tab state for. The maps below are keyed by
 * projectId and would otherwise grow one entry per project ever opened, with no
 * eviction. Keep the N most-recently-touched projects.
 */
const MAX_TRACKED_PROJECTS = 24;

/**
 * Keep only the most-recently-touched projects when persisting. Map keys follow
 * insertion order, and every action re-spreads the touched project's entry, so
 * the tail of the key list is the rough recency order — keeping the last N is a
 * good-enough LRU for a soft cap whose only job is to stop unbounded growth.
 */
function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_PROJECTS) return map;
  const kept = keys.slice(-MAX_TRACKED_PROJECTS);
  return Object.fromEntries(kept.map((k) => [k, map[k]]));
}

interface Actions {
  /** Open a session as a tab (idempotent, appends if absent). */
  openTab: (projectId: string, sessionId: string) => void;
  /** Close a tab. Tracks it on the recently-closed stack. */
  closeTab: (projectId: string, sessionId: string) => void;
  /** Pop the most recently closed tab back open and return its id. */
  reopenLastClosed: (projectId: string) => string | null;
  /** Bulk-replace tabs (e.g. when project loads). */
  setTabs: (projectId: string, sessionIds: string[]) => void;
  /** Get tabs for a project (memoized via store). */
  getTabs: (projectId: string) => string[];
  /** Pop the Customize tab open for this project (idempotent). */
  openCustomizeTab: (projectId: string) => void;
  /** Close the Customize tab for this project. */
  closeCustomizeTab: (projectId: string) => void;
  /** Set the transient "active" override (see `optimisticActiveByProject`). */
  setOptimisticActive: (projectId: string, sessionId: string | null) => void;
}

export const useProjectSessionTabsStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      tabsByProject: {},
      recentlyClosedByProject: {},
      optimisticActiveByProject: {},

      setOptimisticActive: (projectId, sessionId) => {
        const current = get().optimisticActiveByProject[projectId] ?? null;
        if (current === sessionId) return;
        set({
          optimisticActiveByProject: {
            ...get().optimisticActiveByProject,
            [projectId]: sessionId,
          },
        });
      },

      // Customize is just another tab in the ordered list — append on open,
      // drop on close. Same code path as session tabs.
      openCustomizeTab: (projectId) => get().openTab(projectId, CUSTOMIZE_TAB_ID),
      closeCustomizeTab: (projectId) => get().closeTab(projectId, CUSTOMIZE_TAB_ID),

      openTab: (projectId, sessionId) => {
        const current = get().tabsByProject[projectId] ?? [];
        if (current.includes(sessionId)) return;
        const next = [...current, sessionId].slice(-MAX_TABS_PER_PROJECT);
        set({ tabsByProject: { ...get().tabsByProject, [projectId]: next } });
      },

      closeTab: (projectId, sessionId) => {
        const current = get().tabsByProject[projectId] ?? [];
        if (!current.includes(sessionId)) return;
        const next = current.filter((id) => id !== sessionId);
        const closed = get().recentlyClosedByProject[projectId] ?? [];
        const nextClosed = [...closed.filter((id) => id !== sessionId), sessionId].slice(
          -MAX_RECENTLY_CLOSED,
        );
        set({
          tabsByProject: { ...get().tabsByProject, [projectId]: next },
          recentlyClosedByProject: {
            ...get().recentlyClosedByProject,
            [projectId]: nextClosed,
          },
        });
      },

      reopenLastClosed: (projectId) => {
        const closed = get().recentlyClosedByProject[projectId] ?? [];
        if (closed.length === 0) return null;
        const sessionId = closed[closed.length - 1];
        const remainingClosed = closed.slice(0, -1);
        const current = get().tabsByProject[projectId] ?? [];
        const next = current.includes(sessionId)
          ? current
          : [...current, sessionId].slice(-MAX_TABS_PER_PROJECT);
        set({
          tabsByProject: { ...get().tabsByProject, [projectId]: next },
          recentlyClosedByProject: {
            ...get().recentlyClosedByProject,
            [projectId]: remainingClosed,
          },
        });
        return sessionId;
      },

      setTabs: (projectId, sessionIds) => {
        set({
          tabsByProject: {
            ...get().tabsByProject,
            [projectId]: sessionIds.slice(-MAX_TABS_PER_PROJECT),
          },
        });
      },

      getTabs: (projectId) => get().tabsByProject[projectId] ?? [],
    }),
    {
      name: STORAGE_KEY,
      // Shared never-throw storage: a full origin bucket degrades to "tabs
      // didn't persist" instead of an uncaught QuotaExceededError that used to
      // crash the project shell on mount (the write happens in a commit-phase
      // effect, so the throw escaped into React).
      storage: createSafeJSONStorage(),
      // `optimisticActiveByProject` is transient; persisting it would leave a
      // stale highlight pointing at a closed tab on next page load.
      partialize: (state) => ({
        tabsByProject: pruneProjects(state.tabsByProject),
        recentlyClosedByProject: pruneProjects(state.recentlyClosedByProject),
      }),
    },
  ),
);
