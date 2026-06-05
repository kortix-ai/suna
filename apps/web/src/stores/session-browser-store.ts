'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

/**
 * Per-session state for the right-side panel hosted by `session-layout.tsx`.
 *
 * The right panel has three views:
 *   - `actions` — KortixComputer (tool calls, the original "Actions" pane)
 *   - `browser` — internal browser (PreviewTabContent iframe + address bar)
 *   - `files`   — files CRUD'd in this session's sandbox (SessionFilesPanel),
 *                 with merge-to-main / open-change-request actions
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

// 'actions' = tool calls · 'browser' = internal browser · 'explorer' = in-sandbox
// file explorer + preview · 'terminal' = live PTY shell into the sandbox ·
// 'files' = git changes for this session.
export type SessionPanelView = 'actions' | 'browser' | 'explorer' | 'terminal' | 'files';

/**
 * A pending "reveal this file in the Files explorer" request for a session.
 * Set when the user clicks a file path in chat; consumed by the mounted
 * {@link SessionFilesExplorer} which drives its scoped FilesStore. The
 * monotonic `nonce` lets repeated clicks on the same path re-trigger the open.
 */
export interface SessionFileOpenRequest {
  path: string;
  line?: number;
  nonce: number;
}

interface SessionBrowserState {
  /** Active view per session. Defaults to 'actions' when unset. */
  viewBySession: Record<string, SessionPanelView>;

  setView: (sessionId: string, view: SessionPanelView) => void;
  getView: (sessionId: string) => SessionPanelView;

  /** Pending file-open request per session (transient — not persisted). */
  fileOpenBySession: Record<string, SessionFileOpenRequest>;
  /**
   * Ask the session's Files panel to reveal `path`. Also flips the panel to
   * the Files (`explorer`) view so the explorer mounts and consumes it.
   */
  requestFileOpen: (sessionId: string, path: string, line?: number) => void;

  /**
   * The panel-store key of the session whose layout is currently visible —
   * i.e. the OpenCode `chatSessionId` the {@link SessionLayout} keys its panel
   * by. NOT the Kortix session id in the URL (those differ). Registered by the
   * active SessionLayout; read by chat click handlers so a localhost-link or
   * file-path click routes into the right session's panel. Transient.
   */
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}

export const useSessionBrowserStore = create<SessionBrowserState>()(
  persist(
    (set, get) => ({
      viewBySession: {},
      fileOpenBySession: {},
      activeSessionId: null,

      setActiveSessionId: (id) => set({ activeSessionId: id }),

      setView: (sessionId, view) =>
        set((state) => ({
          viewBySession: { ...state.viewBySession, [sessionId]: view },
        })),

      getView: (sessionId) => get().viewBySession[sessionId] ?? 'actions',

      requestFileOpen: (sessionId, path, line) =>
        set((state) => ({
          viewBySession: { ...state.viewBySession, [sessionId]: 'explorer' },
          fileOpenBySession: {
            ...state.fileOpenBySession,
            [sessionId]: {
              path,
              line,
              nonce: (state.fileOpenBySession[sessionId]?.nonce ?? 0) + 1,
            },
          },
        })),
    }),
    {
      name: 'kortix-session-browser',
      storage: createSafeJSONStorage(),
      // Persist only the per-session view choice; file-open requests are transient.
      partialize: (state) => ({ viewBySession: state.viewBySession }),
    },
  ),
);

/** Canonical tab id for a session's internal-browser tab in `useTabStore`. */
export function sessionPreviewTabId(sessionId: string): string {
  return `session-preview:${sessionId}`;
}

/**
 * The panel-store key (OpenCode `chatSessionId`) of the active session layout,
 * or null when no session is visible. Use THIS — not the URL's Kortix session
 * id — as the key for `setView` / `requestFileOpen` / `sessionPreviewTabId`,
 * since {@link SessionLayout} keys its panel by `chatSessionId`, which differs
 * from the Kortix session id in the URL.
 */
export function getActivePanelSessionId(): string | null {
  return useSessionBrowserStore.getState().activeSessionId;
}

/**
 * Reveal a file in the active session's side-panel Files (explorer) tab and
 * make sure the panel is open — the file-path equivalent of clicking a
 * localhost link (which opens the Browser tab via LocalhostLinkInterceptor).
 */
export function openFileInSessionPanel(
  sessionId: string,
  path: string,
  line?: number,
): void {
  useSessionBrowserStore.getState().requestFileOpen(sessionId, path, line);
  useKortixComputerStore.getState().setIsSidePanelOpen(true);
}
