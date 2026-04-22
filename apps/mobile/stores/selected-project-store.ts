/**
 * Tracks which Kortix project a fresh mobile session will be created in.
 * `null` means "use the current default directory" (no override). Persisted
 * via AsyncStorage so the choice survives app restarts.
 *
 * Mirror of apps/web/src/stores/selected-project-store.ts, adapted for RN.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SelectedProjectStore {
  projectId: string | null;
  setProjectId: (id: string | null) => void;
}

export const useSelectedProjectStore = create<SelectedProjectStore>()(
  persist(
    (set) => ({
      projectId: null,
      setProjectId: (id) => set({ projectId: id }),
    }),
    {
      name: 'selected-project-v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
