import { create } from 'zustand';

interface SubmittedFeedback {
  threadId: string;
  messageId: string;
  rating: number;
  timestamp: number;
}

interface FeedbackDrawerState {
  isOpen: boolean;
  rating: number | null;
  threadId?: string;
  messageId?: string;
  // Track last submitted feedback to trigger refetch in TaskCompletedFeedback
  lastSubmittedFeedback: SubmittedFeedback | null;
  openFeedbackDrawer: (options: { 
    rating: number; 
    threadId?: string; 
    messageId?: string;
  }) => void;
  closeFeedbackDrawer: () => void;
  setRating: (rating: number) => void;
  // Called when feedback is successfully submitted
  notifyFeedbackSubmitted: (threadId: string, messageId: string, rating: number) => void;
}

export const useFeedbackDrawerStore = create<FeedbackDrawerState>((set) => ({
  isOpen: false,
  rating: null,
  threadId: undefined,
  messageId: undefined,
  lastSubmittedFeedback: null,
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
  notifyFeedbackSubmitted: (threadId, messageId, rating) =>
    set({
      lastSubmittedFeedback: {
        threadId,
        messageId,
        rating,
        timestamp: Date.now(),
      },
    }),
}));
