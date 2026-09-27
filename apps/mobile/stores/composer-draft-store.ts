/**
 * Composer drafts (COR-143): the text typed into the project-home composer
 * and each thread's composer, persisted so it survives the OS killing the app.
 * Rules live in `lib/session/composer-draft.ts`; the composer hook is
 * `lib/session/use-composer-draft.ts`.
 *
 * Writes are debounced per draft (`DRAFT_WRITE_DELAY_MS`), except an empty
 * write: a sent or cleared composer drops its draft at once, so a kill right
 * after Send cannot bring the sent text back. Cleared on sign-out
 * (`hooks/useAuth.ts` → `reset`), like every other per-user store.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  applyDraftWrite,
  createKeyedDebouncer,
  DRAFT_WRITE_DELAY_MS,
  readDraftText,
  type DraftMap,
} from '@/lib/session/composer-draft';

interface ComposerDraftState {
  drafts: DraftMap;
  /** Writes now. Blank text removes the draft. */
  write: (key: string, text: string) => void;
  /** Sign-out: forget every draft. */
  reset: () => void;
}

const debouncer = createKeyedDebouncer(DRAFT_WRITE_DELAY_MS);

export const useComposerDraftStore = create<ComposerDraftState>()(
  persist(
    (set) => ({
      drafts: {},
      write: (key, text) =>
        set((state) => {
          const drafts = applyDraftWrite(state.drafts, key, text, Date.now());
          return drafts === state.drafts ? state : { drafts };
        }),
      reset: () => {
        debouncer.cancelAll();
        set({ drafts: {} });
      },
    }),
    {
      name: 'kortix.composerDrafts',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ drafts: state.drafts }),
    },
  ),
);

/** The stored draft for `key`, or ''. */
export function readComposerDraft(key: string): string {
  return readDraftText(useComposerDraftStore.getState().drafts, key);
}

/** Saves `text` after the debounce; blank text removes the draft at once. */
export function scheduleComposerDraftWrite(key: string, text: string): void {
  if (!text.trim()) {
    debouncer.cancel(key);
    useComposerDraftStore.getState().write(key, '');
    return;
  }
  debouncer.schedule(key, () => useComposerDraftStore.getState().write(key, text));
}

/** Removes a draft now and drops its pending write (a successful send). */
export function clearComposerDraft(key: string): void {
  debouncer.cancel(key);
  useComposerDraftStore.getState().write(key, '');
}

/**
 * A send succeeded: removes the draft if it is the text that was sent. A send
 * that is not the draft (the Agent tab's "configure a new agent" prompt)
 * leaves the typed draft in place.
 */
export function clearComposerDraftIfSent(key: string, sentText: string): void {
  debouncer.flush();
  if (readComposerDraft(key).trim() === sentText.trim()) clearComposerDraft(key);
}

/** Writes every pending draft now — the app is going to the background. */
export function flushComposerDrafts(): void {
  debouncer.flush();
}
