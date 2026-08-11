'use client';

import { create } from 'zustand';

/**
 * The "New session" click guard.
 *
 * `useNewWorkspaceSession` used a per-hook-instance `useRef` released in the
 * create promise's `.finally()`. Two defects came out of that:
 *
 * 1. The ref released the moment `POST /sessions` resolved (~130ms locally), so
 *    a user hammering the button got one session per click — 10 clicks in 1.3s
 *    provisioned 8 real cloud sandboxes.
 * 2. The ref is per instance, and the workspace shell mounts the hook three times
 *    (sidebar button, shell shortcuts, command palette). Nothing coordinated
 *    them.
 *
 * So the guard is module state keyed by project, and it stays engaged until the
 * navigation to the created session LANDS (or `NEW_SESSION_GUARD_MAX_MS`
 * elapses, so a failed navigation cannot wedge the button). One click, one
 * session, and the control can render itself disabled while it works.
 */

/** Hard release, so nothing can leave the control disabled forever. */
export const NEW_SESSION_GUARD_MAX_MS = 20_000;

export interface NewSessionPending {
  /** Set once the create resolves; the route we are waiting to land on. */
  sessionId: string | null;
}

export type NewSessionPendingMap = Record<string, NewSessionPending>;

/** Repeat activation is a no-op while a create/navigation is still settling. */
export function canBeginNewSession(pending: NewSessionPendingMap, workspaceId: string): boolean {
  return !pending[workspaceId];
}

/** The pathname a workspace's pending create is waiting to land on, or null. */
export function pendingNewSessionPath(
  pending: NewSessionPendingMap,
  workspaceId: string,
): string | null {
  const sessionId = pending[workspaceId]?.sessionId;
  return sessionId ? `/workspaces/${workspaceId}/sessions/${sessionId}` : null;
}

/** True once the browser is showing the session the pending create minted. */
export function hasLandedOnNewSession(
  pending: NewSessionPendingMap,
  workspaceId: string,
  pathname: string | null,
): boolean {
  const target = pendingNewSessionPath(pending, workspaceId);
  return !!target && !!pathname && pathname === target;
}

interface NewSessionGuardState {
  pending: NewSessionPendingMap;
  /** Claim the guard. Returns false when this workspace already holds it. */
  begin: (workspaceId: string) => boolean;
  /** Record the created session id the navigation must land on. */
  target: (workspaceId: string, sessionId: string) => void;
  /** Release the guard. */
  settle: (workspaceId: string) => void;
}

export const useNewSessionGuardStore = create<NewSessionGuardState>((set, get) => ({
  pending: {},
  begin: (workspaceId) => {
    if (!canBeginNewSession(get().pending, workspaceId)) return false;
    set((state) => ({ pending: { ...state.pending, [workspaceId]: { sessionId: null } } }));
    return true;
  },
  target: (workspaceId, sessionId) =>
    set((state) =>
      state.pending[workspaceId]
        ? { pending: { ...state.pending, [workspaceId]: { sessionId } } }
        : state,
    ),
  settle: (workspaceId) =>
    set((state) => {
      if (!state.pending[workspaceId]) return state;
      const next = { ...state.pending };
      delete next[workspaceId];
      return { pending: next };
    }),
}));

/**
 * Whether this workspace has a "New session" create in flight — bind it to the
 * control's `disabled` so the click guard is visible, not just enforced.
 */
export function useIsCreatingWorkspaceSession(workspaceId: string | undefined): boolean {
  return useNewSessionGuardStore((state) => (workspaceId ? !!state.pending[workspaceId] : false));
}
