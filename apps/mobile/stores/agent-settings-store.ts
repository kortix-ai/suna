import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type AgentSettingsState = {
  selectedModel: string;
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  setSelectedModel: (model: string) => void;
  setSelectedAgent: (id: string | null, name?: string | null) => void;
  reset: () => void;
};

const DEFAULT_MODEL = 'claude-sonnet-4';

export const useAgentSettingsStore = create<AgentSettingsState>()(
  persist(
    (set) => ({
      selectedModel: DEFAULT_MODEL,
      selectedAgentId: null,
      selectedAgentName: null,
      setSelectedModel: (model) => set({ selectedModel: model }),
      setSelectedAgent: (id, name = null) => set({ selectedAgentId: id, selectedAgentName: name ?? null }),
      reset: () => set({ selectedModel: DEFAULT_MODEL, selectedAgentId: null, selectedAgentName: null }),
    }),
    {
      name: 'kusor-agent-settings',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);

export const getDefaultModel = () => DEFAULT_MODEL;
