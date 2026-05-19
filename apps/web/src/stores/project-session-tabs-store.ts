'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

interface State {
  /** projectId → ordered list of session_ids currently open as tabs */
  tabsByProject: Record<string, string[]>;
  /** projectId → stack of recently-closed session_ids (most recent last) */
  recentlyClosedByProject: Record<string, string[]>;
  /**
   * projectId → whether the Customize tab is currently open.
   * Customize sits next to the session tabs but isn't a session, so it
   * lives in its own slot rather than mingling with sessionId strings.
   */
  customizeOpenByProject: Record<string, boolean>;
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
}

export const useProjectSessionTabsStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      tabsByProject: {},
      recentlyClosedByProject: {},
      customizeOpenByProject: {},

      openCustomizeTab: (projectId) => {
        if (get().customizeOpenByProject[projectId]) return;
        set({
          customizeOpenByProject: {
            ...get().customizeOpenByProject,
            [projectId]: true,
          },
        });
      },

      closeCustomizeTab: (projectId) => {
        if (!get().customizeOpenByProject[projectId]) return;
        const next = { ...get().customizeOpenByProject };
        delete next[projectId];
        set({ customizeOpenByProject: next });
      },

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
    { name: 'kortix.project-session-tabs' },
  ),
);
