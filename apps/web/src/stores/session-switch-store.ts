'use client';

import { create } from 'zustand';

interface SessionSwitchClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Preserve browser-native new-tab/window behavior and ignore the active row. */
export function shouldBeginSessionSwitch(
  event: SessionSwitchClickLike,
  targetSessionId: string,
  activeSessionId: string | null,
): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    targetSessionId !== activeSessionId
  );
}

/** A click switch spans both Next navigation and the target runtime becoming ready. */
export function shouldShowSessionSwitchLoading(
  targetSessionId: string | null,
  renderedSessionId: string,
  targetReady: boolean,
): boolean {
  if (!targetSessionId) return false;
  return targetSessionId !== renderedSessionId || !targetReady;
}

interface SessionSwitchState {
  targetSessionId: string | null;
  beginSwitch: (sessionId: string) => void;
  completeSwitch: (sessionId: string) => void;
  cancelSwitch: () => void;
}

/**
 * Cross-route client state for project-session navigation. Completion is compare-
 * and-clear so a slow older route can never clear a newer rapid-click target.
 */
export const useSessionSwitchStore = create<SessionSwitchState>((set) => ({
  targetSessionId: null,
  beginSwitch: (sessionId) => set({ targetSessionId: sessionId }),
  completeSwitch: (sessionId) =>
    set((state) =>
      state.targetSessionId === sessionId ? { targetSessionId: null } : state,
    ),
  cancelSwitch: () => set({ targetSessionId: null }),
}));
