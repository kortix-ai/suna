import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ModelStore {
  selectedModel: string;
  setSelectedModel: (model: string) => void;
}

export const useModelStore = create<ModelStore>()(
  persist(
    (set) => ({
      selectedModel: '', // Will be set by the hook based on API data
      setSelectedModel: (model: string) => {
        console.log('🔧 ModelStore: Setting selected model to:', model);
        set({ selectedModel: model });
      },
    }),
    {
      name: 'suna-model-selection-v3',
      partialize: (state) => ({
        selectedModel: state.selectedModel,
      }),
    }
  )
);

// Utility functions for compatibility
export const formatModelName = (name: string): string => {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};
