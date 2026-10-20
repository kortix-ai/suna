'use client';

/**
 * What a session's side panel was showing, kept per chat session across
 * navigation and reloads: open a Terminal in a session, go to another page,
 * come back while the session is still running, and the Terminal is open.
 *
 * Why a memory and not the old open flag. `setActiveSession` closes the right
 * side on every arrival on purpose: a remembered OPEN FLAG made the next
 * session render an open panel with nothing in it (see the comment there).
 * This remembers the VIEW instead, and the panel provider re-opens it through
 * the same request a click makes (`requestQuickView`, or the output click for a
 * file preview), so the panel always arrives with its content.
 *
 * Written by `SessionPanelProvider` while the panel is open on its session,
 * cleared by the person closing it (`setIsSidePanelOpen(false)`, ⌘I), never by
 * the close an arrival makes. A session that is not running is not restored:
 * opening its Terminal would wake its computer.
 *
 * Its own store, not a key in `session-browser-store`: that store imports
 * `kortix-computer-store`, and the close actions there have to clear this one.
 */

import { createSafeJSONStorage } from '../lib/storage/managed-storage';
import type { QuickView, QuickViewTarget } from './kortix-computer-store';
import { registerPersistedStore, resetPersistedStore } from './persisted-store-registry';
import type { ProjectSessionStatus } from '@kortix/sdk';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RememberedPanel =
  /** A view the quick-view request can open: Terminal, Browser, Files, Audit. */
  | { kind: 'view'; view: QuickView; target?: QuickViewTarget }
  /** A file preview, re-opened from the session's outputs by its path. */
  | { kind: 'file'; path: string }
  /** Advanced mode: its view is already kept per session (`viewBySession`); only the open bit is. */
  | { kind: 'open' };

/** Sessions remembered at most; the least recently written goes first. */
export const MAX_REMEMBERED_PANELS = 50;

/**
 * The Easy panel's current content as something that can be opened again, from
 * the provider's state: the terminal flag and the open detail's key (the keys
 * `session-panel-provider.tsx` mints). A tool step is not: it points into one
 * turn's call, and reopening it on arrival would be noise.
 */
export function rememberedPanelOf({
  terminalOpen,
  detailKey,
}: {
  terminalOpen: boolean;
  detailKey: string | null;
}): RememberedPanel | null {
  if (terminalOpen) return { kind: 'view', view: 'terminal' };
  if (detailKey === 'files') return { kind: 'view', view: 'files' };
  if (detailKey === 'files:changes')
    return { kind: 'view', view: 'files', target: { changes: true } };
  if (detailKey === 'audit') return { kind: 'view', view: 'audit' };
  if (detailKey === 'app:landing') return { kind: 'view', view: 'browser' };
  if (detailKey?.startsWith('app:'))
    return { kind: 'view', view: 'browser', target: { url: detailKey.slice(4) } };
  if (detailKey?.startsWith('file:')) return { kind: 'file', path: detailKey.slice(5) };
  return null;
}

/** The panel to reopen on arrival, or null: only on a running session, with the panel closed, on desktop. */
export function panelToRestore({
  remembered,
  status,
  panelOpen,
  isMobile,
}: {
  remembered: RememberedPanel | undefined;
  status: ProjectSessionStatus | undefined;
  panelOpen: boolean;
  isMobile: boolean;
}): RememberedPanel | null {
  if (!remembered || status !== 'running' || panelOpen || isMobile) return null;
  return remembered;
}

interface SessionPanelMemoryState {
  bySession: Record<string, RememberedPanel>;
  /** Remember what `sessionId`'s panel shows; null forgets it. */
  remember: (sessionId: string, panel: RememberedPanel | null) => void;
}

const samePanel = (a: RememberedPanel | undefined, b: RememberedPanel | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b);

export const useSessionPanelMemoryStore = create<SessionPanelMemoryState>()(
  persist(
    (set) => ({
      bySession: {},
      remember: (sessionId, panel) =>
        set((state) => {
          if (samePanel(state.bySession[sessionId], panel)) return state;
          const { [sessionId]: _previous, ...rest } = state.bySession;
          if (!panel) return { bySession: rest };
          const kept = Object.entries(rest).slice(-(MAX_REMEMBERED_PANELS - 1));
          return { bySession: { ...Object.fromEntries(kept), [sessionId]: panel } };
        }),
    }),
    {
      name: 'kortix-session-panel-memory',
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ bySession: state.bySession }),
    },
  ),
);

registerPersistedStore('kortix-session-panel-memory', () =>
  resetPersistedStore(useSessionPanelMemoryStore),
);
