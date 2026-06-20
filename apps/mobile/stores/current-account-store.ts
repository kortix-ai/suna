import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Currently selected account/team — mirrors the web app's useCurrentAccountStore.
 * Persisted so the projects screen reopens on the same account.
 */
interface CurrentAccountState {
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
}

export const useCurrentAccountStore = create<CurrentAccountState>()(
  persist(
    (set) => ({
      selectedAccountId: null,
      setSelectedAccountId: (selectedAccountId) => set({ selectedAccountId }),
    }),
    {
      name: 'kortix.currentAccount',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
