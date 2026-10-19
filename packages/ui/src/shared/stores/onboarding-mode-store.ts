import { create } from 'zustand';

/**
 * Onboarding flow phases:
 *   boot → setup → (chat session) → morph → done
 *
 *   showBoot   = BIOS animation
 *   showSetup  = Provider / tool-keys / Pipedream wizard
 *   (neither)  = chat session (sessionId is set, dashboard is chromeless)
 *   morphing   = sidebars animate in
 *   done       = normal dashboard
 */
interface OnboardingModeState {
  /** Dashboard is in onboarding mode (full-screen thread, no chrome) */
  active: boolean;
  /** Sidebars are animating in (onboarding → dashboard morph) */
  morphing: boolean;
  /** Show BIOS + logo boot overlay */
  showBoot: boolean;
  /** Show provider setup wizard (between boot and chat) */
  showSetup: boolean;
  /** Onboarding session ID once created/resumed */
  sessionId: string | null;

  enter: (opts?: { skipBoot?: boolean; skipSetup?: boolean }) => void;
  setSessionId: (id: string | null) => void;
  hideBoot: () => void;
  hideSetup: () => void;
  morph: () => void;
  done: () => void;
}

export const useOnboardingModeStore = create<OnboardingModeState>((set) => ({
  active: false,
  morphing: false,
  showBoot: false,
  showSetup: false,
  sessionId: null,

  enter: (opts) =>
    set({
      active: true,
      showBoot: !opts?.skipBoot,
      showSetup: !opts?.skipSetup,
      morphing: false,
      sessionId: null,
    }),
  setSessionId: (id) => set({ sessionId: id }),
  hideBoot: () => set({ showBoot: false }),
  hideSetup: () => set({ showSetup: false }),
  morph: () => set({ morphing: true }),
  done: () =>
    set({ active: false, morphing: false, sessionId: null, showBoot: false, showSetup: false }),
}));
