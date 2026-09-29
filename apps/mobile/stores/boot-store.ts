/**
 * Boot flags for the native splash (KRTX-244). In memory only: every launch
 * boots once. The decision is `shouldHideSplash` (lib/boot/splash-gate.ts);
 * `app/_layout.tsx` hides the splash and sets `splashHidden`.
 */

import { create } from 'zustand';

interface BootState {
  /** The start screen or the upgrade screen has content to show (not a loader). */
  landingSettled: boolean;
  /** The splash safety timeout passed. */
  timedOut: boolean;
  /** The native splash is hidden: screens own their loaders from here on. */
  splashHidden: boolean;
  settleLanding: () => void;
  timeOut: () => void;
  markSplashHidden: () => void;
}

export const useBootStore = create<BootState>()((set) => ({
  landingSettled: false,
  timedOut: false,
  splashHidden: false,
  settleLanding: () => set((s) => (s.landingSettled ? s : { landingSettled: true })),
  timeOut: () => set((s) => (s.timedOut ? s : { timedOut: true })),
  markSplashHidden: () => set((s) => (s.splashHidden ? s : { splashHidden: true })),
}));
