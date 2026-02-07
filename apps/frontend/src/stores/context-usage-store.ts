import { create } from 'zustand';

interface ContextUsageData {
  current_tokens: number;
}

interface SummarizingData {
  status: 'started' | 'completed' | 'failed';
  tokens_before?: number;
  tokens_after?: number;
}

interface ContextUsageStore {
  usageByThread: Record<string, ContextUsageData>;
  summarizingByThread: Record<string, SummarizingData>;
  setUsage: (threadId: string, usage: any) => void;
  getUsage: (threadId: string) => ContextUsageData | null;
  setSummarizing: (threadId: string, data: SummarizingData) => void;
  isSummarizing: (threadId: string) => boolean;
}

export const useContextUsageStore = create<ContextUsageStore>((set, get) => ({
  usageByThread: {},
  summarizingByThread: {},
  setUsage: (threadId, usage) => {
    set((state) => ({
      usageByThread: { ...state.usageByThread, [threadId]: { current_tokens: usage.current_tokens } },
    }));
  },
  getUsage: (threadId) => get().usageByThread[threadId] || null,
  setSummarizing: (threadId, data) => {
    set((state) => ({
      summarizingByThread: { ...state.summarizingByThread, [threadId]: data },
    }));
  },
  isSummarizing: (threadId) => get().summarizingByThread[threadId]?.status === 'started',
}));

