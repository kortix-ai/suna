import { create } from 'zustand';

interface DocumentModalState {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
}

export const useDocumentModalStore = create<DocumentModalState>((set) => ({
  isOpen: false,
  setIsOpen: (isOpen) => {
    console.log('Document modal store - setting isOpen to:', isOpen);
    set({ isOpen });
  },
})); 