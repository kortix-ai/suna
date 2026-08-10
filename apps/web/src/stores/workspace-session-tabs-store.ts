'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Per-workspace open-session tabs.
 *
 * A "tab" here = a workspace session_id currently surfaced in the top bar.
 * Tabs persist across reloads so the user comes back to the same set of
 * sessions they had open. Cap at MAX so the bar can't grow unbounded.
 *
 * Scope: the workspace shell only. The legacy tab-store (instances) is a
 * different beast and we intentionally don't reuse it.
 */

const MAX_TABS_PER_WORKSPACE = 8;
const MAX_RECENTLY_CLOSED = 16;

/**
 * Sentinel tab id for the workspace's Customize surface. Customize lives in the
 * same ordered tab list as sessions so it behaves like any other tab — it
 * opens where you put it, keeps its position, and closes with Cmd/Ctrl+W.
 * The literal can't collide with a session_id (those are UUIDs).
 */
export const CUSTOMIZE_TAB_ID = 'customize';

interface State {
  /**
   * workspaceId → ordered list of open tab ids. Entries are session_ids, plus
   * the CUSTOMIZE_TAB_ID sentinel when the Customize tab is open.
   */
  tabsByWorkspace: Record<string, string[]>;
  /** workspaceId → stack of recently-closed tab ids (most recent last) */
  recentlyClosedByWorkspace: Record<string, string[]>;
  /**
   * Transient override of which tab is "active" in the bar. Set the moment
   * a close-and-switch transition starts so the highlight moves before
   * Next.js commits the new URL — `usePathname` only flips after the route
   * has resolved. Cleared once the real URL catches up. Not persisted.
   */
  optimisticActiveByWorkspace: Record<string, string | null>;
}

const STORAGE_KEY = 'kortix.workspace-session-tabs';

/**
 * Cap how many workspaces retain tab state. The maps below are keyed by
 * workspaceId and would otherwise grow one entry per workspace ever opened.
 * Keep the N most-recently-touched workspaces.
 */
const MAX_TRACKED_WORKSPACES = 24;

/**
 * Keep only the most-recently-touched workspaces when persisting. Map keys follow
 * insertion order, and every action re-spreads the touched workspace's entry, so
 * the tail of the key list is the rough recency order — keeping the last N is a
 * good-enough LRU for a soft cap whose only job is to stop unbounded growth.
 */
function pruneWorkspaces<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_WORKSPACES) return map;
  const kept = keys.slice(-MAX_TRACKED_WORKSPACES);
  return Object.fromEntries(kept.map((k) => [k, map[k]]));
}

interface Actions {
  /** Open a session as a tab (idempotent, appends if absent). */
  openTab: (workspaceId: string, sessionId: string) => void;
  /** Close a tab. Tracks it on the recently-closed stack. */
  closeTab: (workspaceId: string, sessionId: string) => void;
  /** Pop the most recently closed tab back open and return its id. */
  reopenLastClosed: (workspaceId: string) => string | null;
  /** Bulk-replace tabs when a workspace loads. */
  setTabs: (workspaceId: string, sessionIds: string[]) => void;
  /** Get tabs for a workspace (memoized via store). */
  getTabs: (workspaceId: string) => string[];
  /** Pop the Customize tab open for this workspace (idempotent). */
  openCustomizeTab: (workspaceId: string) => void;
  /** Close the Customize tab for this workspace. */
  closeCustomizeTab: (workspaceId: string) => void;
  /** Set the transient "active" override (see `optimisticActiveByWorkspace`). */
  setOptimisticActive: (workspaceId: string, sessionId: string | null) => void;
}

export const useWorkspaceSessionTabsStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      tabsByWorkspace: {},
      recentlyClosedByWorkspace: {},
      optimisticActiveByWorkspace: {},

      setOptimisticActive: (workspaceId, sessionId) => {
        const current = get().optimisticActiveByWorkspace[workspaceId] ?? null;
        if (current === sessionId) return;
        set({
          optimisticActiveByWorkspace: {
            ...get().optimisticActiveByWorkspace,
            [workspaceId]: sessionId,
          },
        });
      },

      // Customize is just another tab in the ordered list — append on open,
      // drop on close. Same code path as session tabs.
      openCustomizeTab: (workspaceId) => get().openTab(workspaceId, CUSTOMIZE_TAB_ID),
      closeCustomizeTab: (workspaceId) => get().closeTab(workspaceId, CUSTOMIZE_TAB_ID),

      openTab: (workspaceId, sessionId) => {
        const current = get().tabsByWorkspace[workspaceId] ?? [];
        if (current.includes(sessionId)) return;
        const next = [...current, sessionId].slice(-MAX_TABS_PER_WORKSPACE);
        set({ tabsByWorkspace: { ...get().tabsByWorkspace, [workspaceId]: next } });
      },

      closeTab: (workspaceId, sessionId) => {
        const current = get().tabsByWorkspace[workspaceId] ?? [];
        if (!current.includes(sessionId)) return;
        const next = current.filter((id) => id !== sessionId);
        const closed = get().recentlyClosedByWorkspace[workspaceId] ?? [];
        const nextClosed = [...closed.filter((id) => id !== sessionId), sessionId].slice(
          -MAX_RECENTLY_CLOSED,
        );
        set({
          tabsByWorkspace: { ...get().tabsByWorkspace, [workspaceId]: next },
          recentlyClosedByWorkspace: {
            ...get().recentlyClosedByWorkspace,
            [workspaceId]: nextClosed,
          },
        });
      },

      reopenLastClosed: (workspaceId) => {
        const closed = get().recentlyClosedByWorkspace[workspaceId] ?? [];
        if (closed.length === 0) return null;
        const sessionId = closed[closed.length - 1];
        const remainingClosed = closed.slice(0, -1);
        const current = get().tabsByWorkspace[workspaceId] ?? [];
        const next = current.includes(sessionId)
          ? current
          : [...current, sessionId].slice(-MAX_TABS_PER_WORKSPACE);
        set({
          tabsByWorkspace: { ...get().tabsByWorkspace, [workspaceId]: next },
          recentlyClosedByWorkspace: {
            ...get().recentlyClosedByWorkspace,
            [workspaceId]: remainingClosed,
          },
        });
        return sessionId;
      },

      setTabs: (workspaceId, sessionIds) => {
        set({
          tabsByWorkspace: {
            ...get().tabsByWorkspace,
            [workspaceId]: sessionIds.slice(-MAX_TABS_PER_WORKSPACE),
          },
        });
      },

      getTabs: (workspaceId) => get().tabsByWorkspace[workspaceId] ?? [],
    }),
    {
      name: STORAGE_KEY,
      // Shared never-throw storage: a full origin bucket degrades to "tabs
      // didn't persist" instead of an uncaught QuotaExceededError that used to
      // crash the workspace shell on mount (the write happens in a commit-phase
      // effect, so the throw escaped into React).
      storage: createSafeJSONStorage(),
      version: 1,
      migrate: (persisted) => {
        const legacy = persisted as Partial<State> & {
          tabsByProject?: Record<string, string[]>;
          recentlyClosedByProject?: Record<string, string[]>;
        };
        return {
          ...legacy,
          tabsByWorkspace: legacy.tabsByWorkspace ?? legacy.tabsByProject ?? {},
          recentlyClosedByWorkspace:
            legacy.recentlyClosedByWorkspace ?? legacy.recentlyClosedByProject ?? {},
        } as State & Actions;
      },
      // `optimisticActiveByWorkspace` is transient; persisting it would leave a
      // stale highlight pointing at a closed tab on next page load.
      partialize: (state) => ({
        tabsByWorkspace: pruneWorkspaces(state.tabsByWorkspace),
        recentlyClosedByWorkspace: pruneWorkspaces(state.recentlyClosedByWorkspace),
      }),
    },
  ),
);
