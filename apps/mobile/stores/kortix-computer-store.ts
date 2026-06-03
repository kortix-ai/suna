import { create } from 'zustand';

export type ViewType = 'tools' | 'browser';

interface KortixComputerState {
  activeView: ViewType;
  isOpen: boolean;
  pendingToolNavIndex: number | null;

  setActiveView: (view: ViewType) => void;
  navigateToToolCall: (toolIndex: number) => void;
  clearPendingToolNav: () => void;
  openPanel: () => void;
  closePanel: () => void;
  reset: () => void;
}

const initialState = {
  activeView: 'tools' as ViewType,
  isOpen: false,
  pendingToolNavIndex: null as number | null,
};

export const useKortixComputerStore = create<KortixComputerState>((set) => ({
  ...initialState,

  setActiveView: (view: ViewType) => {
    set({ activeView: view });
  },

  navigateToToolCall: (toolIndex: number) => {
    set({
      isOpen: true,
      activeView: 'tools',
      pendingToolNavIndex: toolIndex,
    });
  },

  clearPendingToolNav: () => {
    set({ pendingToolNavIndex: null });
  },

  openPanel: () => {
    set({ isOpen: true });
  },

  closePanel: () => {
    set({ isOpen: false });
  },

  reset: () => {
    set(initialState);
  },
}));
