import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Tracks which project the dashboard empty-state chat input will create the
 * next session in. `null` means "use the current default directory" (no
 * override). Persisted so the choice survives reloads and new tabs.
 */
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
    { name: 'dashboard-selected-project-v1' },
  ),
);
