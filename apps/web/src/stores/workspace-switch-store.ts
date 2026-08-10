'use client';

import { create } from 'zustand';

/**
 * Tracks an in-flight switch between workspaces so the chrome can render a
 * progress bar / pulse while navigation + data fetch settle.
 *
 * `targetWorkspaceId` is what we're switching TO. The workspace shell clears it
 * the moment the URL's workspaceId equals the target — i.e., the new page is
 * rendering. Any data-fetch is gated separately by React Query.
 */
interface State {
  targetWorkspaceId: string | null;
  beginSwitch: (workspaceId: string) => void;
  endSwitch: () => void;
}

export const useWorkspaceSwitchStore = create<State>((set) => ({
  targetWorkspaceId: null,
  beginSwitch: (workspaceId) => set({ targetWorkspaceId: workspaceId }),
  endSwitch: () => set({ targetWorkspaceId: null }),
}));

/** Convenience boolean — true while a workspace switch is in flight. */
export function useIsSwitchingWorkspace(): boolean {
  return useWorkspaceSwitchStore((s) => s.targetWorkspaceId !== null);
}
