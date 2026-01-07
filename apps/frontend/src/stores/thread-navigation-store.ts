'use client';

import { create } from 'zustand';

interface NavigatingThread {
  threadId: string;
  projectId: string;
  projectName: string;
  iconName?: string;
}

interface ThreadNavigationStore {
  // The thread we're navigating to (shows skeleton immediately)
  navigatingTo: NavigatingThread | null;
  
  // Start navigating to a thread - shows skeleton immediately
  startNavigation: (thread: NavigatingThread) => void;
  
  // Clear navigation state when the new page has loaded
  clearNavigation: () => void;
  
  // Check if we're navigating to a specific thread
  isNavigatingTo: (threadId: string) => boolean;
}

export const useThreadNavigationStore = create<ThreadNavigationStore>((set, get) => ({
  navigatingTo: null,
  
  startNavigation: (thread) => {
    set({ navigatingTo: thread });
  },
  
  clearNavigation: () => {
    set({ navigatingTo: null });
  },
  
  isNavigatingTo: (threadId) => {
    return get().navigatingTo?.threadId === threadId;
  },
}));

// Selectors for performance
export const useNavigatingThread = () => useThreadNavigationStore((state) => state.navigatingTo);
export const useStartNavigation = () => useThreadNavigationStore((state) => state.startNavigation);
export const useClearNavigation = () => useThreadNavigationStore((state) => state.clearNavigation);




