'use client';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Per-session state for the right-side panel hosted by `session-layout.tsx`.
 *
 * The right panel has three views:
 *   - `actions` — KortixComputer (tool calls, the original "Actions" pane)
 *   - `browser` — internal browser (BrowserPanel iframe + address bar)
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
// 'files' = git changes for this session · 'audit' = governed-action trail +
// pending approvals for this session.
export type SessionPanelView = 'actions' | 'browser' | 'explorer' | 'terminal' | 'files' | 'audit';

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
  /** Epoch ms the request was made. Lets a consumer that mounts as a RESULT
   *  of the request (mobile drawer, Easy detail) distinguish a just-fired
   *  request from a stale leftover. */
  requestedAt: number;
}

/**
 * A pending "open this running port in the panel" request for a session. Set
 * when the user clicks a localhost URL in the transcript (the chips and cards
 * `SandboxUrlDetector` appends); consumed by the mounted Easy panel, which
 * opens it as the same `AppPreview` detail a Preview-card row opens.
 *
 * Nonce'd for the same reason {@link SessionFileOpenRequest} is: clicking the
 * same port twice must re-open it, and an identical payload wouldn't re-render
 * the consumer on its own.
 */
export interface SessionAppOpenRequest {
  /**
   * The INTERNAL sandbox url — `http://localhost:PORT/path`. `AppPreview`
   * proxies whatever it is given, so handing it an already-proxied url would
   * proxy it twice and 404.
   */
  url: string;
  /** Label for the detail header. Falls back to the port when absent. */
  name?: string;
  nonce: number;
  /** Epoch ms — same staleness contract as {@link SessionFileOpenRequest}. */
  requestedAt: number;
}

interface SessionBrowserState {
  /** Active view per session. Defaults to 'actions' when unset. */
  viewBySession: Record<string, SessionPanelView>;
  /** Dedicated side-panel terminal PTY per Runtime chat session. */
  terminalPtyBySession: Record<string, string>;

  setView: (sessionId: string, view: SessionPanelView) => void;
  getView: (sessionId: string) => SessionPanelView;
  setTerminalPty: (sessionId: string, ptyId: string | null) => void;

  /** Pending file-open request per session (transient — not persisted). */
  fileOpenBySession: Record<string, SessionFileOpenRequest>;
  /**
   * Ask the session's Files panel to reveal `path`. Also flips the panel to
   * the Files (`explorer`) view so the explorer mounts and consumes it.
   */
  requestFileOpen: (sessionId: string, path: string, line?: number) => void;

  /**
   * Same file-open request as {@link requestFileOpen}, WITHOUT flipping
   * `viewBySession`. For callers that mount their own `SessionFilesExplorer`
   * in place (Easy mode's own file drill-in — see `easy-panel.tsx`) and must
   * not touch the shared per-session view: `session-layout.tsx` promises
   * Advanced mode resumes wherever the user left it, and Easy mode has no
   * tab strip that view could even point at.
   */
  requestFileOpenSilently: (sessionId: string, path: string, line?: number) => void;

  /**
   * Remove a delivered (or discarded) file-open request. Nonce-guarded so a
   * newer request that raced in is never destroyed by a late consumer.
   */
  consumeFileOpen: (sessionId: string, nonce: number) => void;

  /** Pending port-open request per session (transient — not persisted). */
  appOpenBySession: Record<string, SessionAppOpenRequest>;

  /**
   * Ask the session's panel to open `url` (an internal `http://localhost:PORT`
   * address) as a running app. Deliberately silent about `viewBySession` — the
   * same reasoning as {@link requestFileOpenSilently}: Easy mode has no tab
   * strip for that view to point at, and Advanced mode's promise is that it
   * resumes wherever the user left it. Callers that need Advanced's own
   * `BrowserPanel` flip the view themselves (see `openPortInSessionPanel`).
   */
  requestAppOpen: (sessionId: string, url: string, name?: string) => void;

  /** Remove a delivered (or discarded) port-open request. Nonce-guarded. */
  consumeAppOpen: (sessionId: string, nonce: number) => void;

  /**
   * The panel-store key of the session whose layout is currently visible —
   * i.e. the Runtime `chatSessionId` the {@link SessionLayout} keys its panel
   * by. NOT the Kortix session id in the URL (those differ). Registered by the
   * active SessionLayout; read by chat click handlers so a localhost-link or
   * file-path click routes into the right session's panel. Transient.
   */
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}

// Monotonic across ALL sessions and independent of `fileOpenBySession`'s
// current contents — nonces must keep increasing even after `consumeFileOpen`
// deletes an entry, otherwise the next request for that session would
// restart from 1 and could collide with a nonce a consumer already observed
// (and deleted) via `consumeFileOpen`, silently swallowing the new request.
let nextFileOpenNonce = 1;

/** Same monotonic-across-sessions contract as `nextFileOpenNonce` above. */
let nextAppOpenNonce = 1;

export const useSessionBrowserStore = create<SessionBrowserState>()(
  persist(
    (set, get) => ({
      viewBySession: {},
      terminalPtyBySession: {},
      fileOpenBySession: {},
      appOpenBySession: {},
      activeSessionId: null,

      setActiveSessionId: (id) => set({ activeSessionId: id }),

      setView: (sessionId, view) =>
        set((state) => ({
          viewBySession: { ...state.viewBySession, [sessionId]: view },
        })),

      getView: (sessionId) => get().viewBySession[sessionId] ?? 'actions',

      setTerminalPty: (sessionId, ptyId) =>
        set((state) => {
          const next = { ...state.terminalPtyBySession };
          if (ptyId) next[sessionId] = ptyId;
          else delete next[sessionId];
          return { terminalPtyBySession: next };
        }),

      requestFileOpen: (sessionId, path, line) =>
        set((state) => ({
          viewBySession: { ...state.viewBySession, [sessionId]: 'explorer' },
          fileOpenBySession: {
            ...state.fileOpenBySession,
            [sessionId]: {
              path,
              line,
              nonce: nextFileOpenNonce++,
              requestedAt: Date.now(),
            },
          },
        })),

      requestFileOpenSilently: (sessionId, path, line) =>
        set((state) => ({
          fileOpenBySession: {
            ...state.fileOpenBySession,
            [sessionId]: {
              path,
              line,
              nonce: nextFileOpenNonce++,
              requestedAt: Date.now(),
            },
          },
        })),

      consumeFileOpen: (sessionId, nonce) =>
        set((state) => {
          if (state.fileOpenBySession[sessionId]?.nonce !== nonce) return {};
          const next = { ...state.fileOpenBySession };
          delete next[sessionId];
          return { fileOpenBySession: next };
        }),

      requestAppOpen: (sessionId, url, name) =>
        set((state) => ({
          appOpenBySession: {
            ...state.appOpenBySession,
            [sessionId]: {
              url,
              name,
              nonce: nextAppOpenNonce++,
              requestedAt: Date.now(),
            },
          },
        })),

      consumeAppOpen: (sessionId, nonce) =>
        set((state) => {
          if (state.appOpenBySession[sessionId]?.nonce !== nonce) return {};
          const next = { ...state.appOpenBySession };
          delete next[sessionId];
          return { appOpenBySession: next };
        }),
    }),
    {
      name: 'kortix-session-browser',
      storage: createSafeJSONStorage(),
      // Persist stable per-session UI choices; file-open requests are transient.
      partialize: (state) => ({
        viewBySession: state.viewBySession,
        terminalPtyBySession: state.terminalPtyBySession,
      }),
    },
  ),
);

/** Canonical tab id for a session's internal-browser tab in `useTabStore`. */
export function sessionPreviewTabId(sessionId: string): string {
  return `session-preview:${sessionId}`;
}

/**
 * The panel-store key (Runtime `chatSessionId`) of the active session layout,
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
export function openFileInSessionPanel(sessionId: string, path: string, line?: number): void {
  useSessionBrowserStore.getState().requestFileOpen(sessionId, path, line);
  useKortixComputerStore.getState().setIsSidePanelOpen(true);
}
