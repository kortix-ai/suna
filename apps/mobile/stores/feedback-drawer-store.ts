import { create } from 'zustand';

interface FeedbackDrawerState {
  isOpen: boolean;
  rating: number | null;
  threadId?: string;
  messageId?: string;
  openFeedbackDrawer: (options: { 
    rating: number; 
    threadId?: string; 
    messageId?: string;
  }) => void;
  closeFeedbackDrawer: () => void;
  setRating: (rating: number) => void;
}

export const useFeedbackDrawerStore = create<FeedbackDrawerState>((set) => ({
  isOpen: false,
  rating: null,
  threadId: undefined,
  messageId: undefined,
  openFeedbackDrawer: (options) =>
    set({
      isOpen: true,
      rating: options.rating,
      threadId: options.threadId,
      messageId: options.messageId,
    }),
  closeFeedbackDrawer: () =>
    set({
      isOpen: false,
      rating: null,
      threadId: undefined,
      messageId: undefined,
    }),
  setRating: (rating) => set({ rating }),
}));

