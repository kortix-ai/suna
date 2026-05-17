'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Per-session state for the right-side panel hosted by `session-layout.tsx`.
 *
 * The right panel has two views:
 *   - `actions` — KortixComputer (tool calls, the original "Actions" pane)
 *   - `browser` — internal browser (PreviewTabContent iframe + address bar)
 *
 * Both share the same panel real estate; the user toggles between them via
 * a switcher in the panel header. State is keyed by sessionId so each
 * session remembers its own preferred view.
 *
 * Tab data for the browser (current URL, history, address-bar state)
 * lives in `useTabStore` under the canonical id
 * `session-preview:{sessionId}`. We just track the per-session UI choice
 * here.
 */

export type SessionPanelView = 'actions' | 'browser';

interface SessionBrowserState {
  /** Active view per session. Defaults to 'actions' when unset. */
  viewBySession: Record<string, SessionPanelView>;

  setView: (sessionId: string, view: SessionPanelView) => void;
  getView: (sessionId: string) => SessionPanelView;
}

export const useSessionBrowserStore = create<SessionBrowserState>()(
  persist(
    (set, get) => ({
      viewBySession: {},

      setView: (sessionId, view) =>
        set((state) => ({
          viewBySession: { ...state.viewBySession, [sessionId]: view },
        })),

      getView: (sessionId) => get().viewBySession[sessionId] ?? 'actions',
    }),
    {
      name: 'kortix-session-browser',
      partialize: (state) => ({ viewBySession: state.viewBySession }),
    },
  ),
);

/** Canonical tab id for a session's internal-browser tab in `useTabStore`. */
export function sessionPreviewTabId(sessionId: string): string {
  return `session-preview:${sessionId}`;
}
