import { create } from 'zustand';

interface MessageJumpStore {
  targetMessageId: string | null;
  jumpToMessage: (messageId: string) => void;
  clearTarget: () => void;
}

export const useMessageJumpStore = create<MessageJumpStore>((set) => ({
  targetMessageId: null,
  jumpToMessage: (messageId) => set({ targetMessageId: messageId }),
  clearTarget: () => set({ targetMessageId: null }),
}));
