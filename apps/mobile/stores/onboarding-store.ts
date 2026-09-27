/**
 * First-run onboarding state (COR-161): which users have seen the upgrade
 * screen (`app/welcome.tsx`), so it shows once per user.
 *
 * Keyed by user id: a phone outlives a session, and the next person to sign
 * in gets their own first run. Deliberately NOT cleared on sign-out (unlike
 * the other per-user stores, `hooks/useAuth.ts`): signing out and back in
 * must not bring the upgrade screen back. The routing rule is
 * `startDestination` in `lib/onboarding/onboarding.ts`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface OnboardingState {
  /** user id → true once the upgrade screen was shown */
  upgradeSeenByUser: Record<string, true>;
  markUpgradeSeen: (userId: string) => void;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      upgradeSeenByUser: {},
      markUpgradeSeen: (userId) =>
        set((state) =>
          state.upgradeSeenByUser[userId]
            ? state
            : { upgradeSeenByUser: { ...state.upgradeSeenByUser, [userId]: true } }
        ),
    }),
    {
      name: 'kortix.onboarding',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
