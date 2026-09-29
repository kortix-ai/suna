/**
 * Which session parents and drawer sections the user opened or closed
 * (KRTX-639). Only explicit choices are stored: the automatic state (the
 * active session's parent opens, a child search match opens) is computed on
 * render (`isParentExpanded`, lib/session/session-tree). In memory for the
 * app's lifetime, like `useSessionFilterStore`: opening a session unmounts
 * the Sessions page and must not collapse what the user opened. Sign-out
 * resets it (`resetUserStores` in hooks/useAuth.ts).
 */

import { create } from 'zustand';

import type { DrawerSectionId } from '@/lib/session/session-tree';

/** `<projectId>:<parentSessionId>` — a session id is unique, the project scopes the sign-out. */
export const parentKey = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;
/** A drawer section's open/closed choice. */
export const sectionKey = (projectId: string, section: DrawerSectionId) => `${projectId}:section:${section}`;

interface SessionTreeState {
  /** key → the user's explicit open (true) or closed (false) choice. */
  choices: Record<string, boolean>;
  setChoice: (key: string, open: boolean) => void;
  reset: () => void;
}

export const useSessionTreeStore = create<SessionTreeState>()((set) => ({
  choices: {},
  setChoice: (key, open) =>
    set((state) => (state.choices[key] === open ? state : { choices: { ...state.choices, [key]: open } })),
  reset: () => set((state) => (Object.keys(state.choices).length === 0 ? state : { choices: {} })),
}));
