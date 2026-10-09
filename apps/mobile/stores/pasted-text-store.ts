/** The open "Pasted text" sheet's text (null while closed); `PastedTextSheet` in `app/_layout.tsx` renders it. */
import { create } from 'zustand';

export interface PastedTextState {
  text: string | null;
  open: (text: string) => void;
  close: () => void;
}

export const usePastedTextStore = create<PastedTextState>()((set) => ({
  text: null,
  open: (text) => set({ text }),
  close: () => set({ text: null }),
}));

/** Opens a paste's full text: a sent message's tile, a composer's tile (`Composer` `onOpenPaste`). */
export function openPastedText(paste: { text: string }): void {
  usePastedTextStore.getState().open(paste.text);
}
