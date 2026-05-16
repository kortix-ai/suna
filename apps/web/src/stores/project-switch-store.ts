'use client';

import { create } from 'zustand';

/**
 * Tracks an in-flight switch between projects so the chrome can render a
 * progress bar / pulse while navigation + data fetch settle.
 *
 * `targetProjectId` is what we're switching TO. The project shell clears it
 * the moment the URL's projectId equals the target — i.e., the new page is
 * rendering. Any data-fetch is gated separately by React Query.
 */
interface State {
  targetProjectId: string | null;
  beginSwitch: (projectId: string) => void;
  endSwitch: () => void;
}

export const useProjectSwitchStore = create<State>((set) => ({
  targetProjectId: null,
  beginSwitch: (projectId) => set({ targetProjectId: projectId }),
  endSwitch: () => set({ targetProjectId: null }),
}));

/** Convenience boolean — true while a project switch is in flight. */
export function useIsSwitchingProject(): boolean {
  return useProjectSwitchStore((s) => s.targetProjectId !== null);
}
