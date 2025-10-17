import { create } from 'zustand';

interface ContextUsageData {
  current_tokens: number;
}

interface ContextUsageStore {
  usageByThread: Record<string, ContextUsageData>;
  setUsage: (threadId: string, usage: any) => void;
  getUsage: (threadId: string) => ContextUsageData | null;
}

export const useContextUsageStore = create<ContextUsageStore>((set, get) => ({
  usageByThread: {},
  setUsage: (threadId, usage) => {
    set((state) => ({
      usageByThread: { ...state.usageByThread, [threadId]: { current_tokens: usage.current_tokens } },
    }));
  },
  getUsage: (threadId) => get().usageByThread[threadId] || null,
}));

