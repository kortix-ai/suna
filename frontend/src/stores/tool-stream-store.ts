import { create } from 'zustand';

export interface ToolStreamData {
  toolCallId: string;
  toolName: string;
  output: string;
  isFinal: boolean;
  timestamp: number;
}

interface ToolStreamState {
  streamingOutputs: Map<string, string>;
  streamingStatus: Map<string, 'streaming' | 'complete'>;
  
  appendOutput: (toolCallId: string, output: string) => void;
  markComplete: (toolCallId: string) => void;
  getOutput: (toolCallId: string) => string;
  isStreaming: (toolCallId: string) => boolean;
  clearStream: (toolCallId: string) => void;
  clearAll: () => void;
}

export const useToolStreamStore = create<ToolStreamState>((set, get) => ({
  streamingOutputs: new Map(),
  streamingStatus: new Map(),
  
  appendOutput: (toolCallId: string, output: string) => {
    set((state) => {
      const newOutputs = new Map(state.streamingOutputs);
      const currentOutput = newOutputs.get(toolCallId) || '';
      newOutputs.set(toolCallId, currentOutput + output);
      
      const newStatus = new Map(state.streamingStatus);
      newStatus.set(toolCallId, 'streaming');
      
      return {
        streamingOutputs: newOutputs,
        streamingStatus: newStatus,
      };
    });
  },
  
  markComplete: (toolCallId: string) => {
    set((state) => {
      const newStatus = new Map(state.streamingStatus);
      newStatus.set(toolCallId, 'complete');
      return { streamingStatus: newStatus };
    });
  },
  
  getOutput: (toolCallId: string) => {
    return get().streamingOutputs.get(toolCallId) || '';
  },
  
  isStreaming: (toolCallId: string) => {
    return get().streamingStatus.get(toolCallId) === 'streaming';
  },
  
  clearStream: (toolCallId: string) => {
    set((state) => {
      const newOutputs = new Map(state.streamingOutputs);
      const newStatus = new Map(state.streamingStatus);
      newOutputs.delete(toolCallId);
      newStatus.delete(toolCallId);
      return {
        streamingOutputs: newOutputs,
        streamingStatus: newStatus,
      };
    });
  },
  
  clearAll: () => {
    set({
      streamingOutputs: new Map(),
      streamingStatus: new Map(),
    });
  },
}));

