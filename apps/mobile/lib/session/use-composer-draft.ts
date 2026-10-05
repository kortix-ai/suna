/**
 * Keeps a composer's text in the persisted draft store (COR-143).
 *
 * - Restore: once per key, after the store has hydrated, and only into an
 *   empty composer — text handed in at mount (a question prompt's saved
 *   input, a cancelled start's prompt) wins over the stored draft.
 * - Save: every change after the restore, debounced; blank text removes it.
 * - Flush: pending writes run when the app leaves the foreground, the last
 *   moment before the OS may kill it.
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import {
  flushComposerDrafts,
  readComposerDraft,
  scheduleComposerDraftWrite,
  useComposerDraftStore,
} from '@/stores/composer-draft-store';

// One listener for the whole app, installed on first use.
let flushListenerInstalled = false;
function installFlushOnBackground() {
  if (flushListenerInstalled) return;
  flushListenerInstalled = true;
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') flushComposerDrafts();
  });
}

/**
 * `key` from `draftKey` (`lib/session/composer-draft.ts`); null disables the
 * draft. `setText` must be stable (a `useState` setter).
 */
export function useComposerDraft(
  key: string | null,
  text: string,
  setText: (text: string) => void,
): void {
  const restoredFor = useRef<string | null>(null);
  // The text a restore handed to `setText`, until that render lands.
  const pendingRestore = useRef<string | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!key) return;
    installFlushOnBackground();
    const restore = () => {
      if (restoredFor.current === key) return;
      restoredFor.current = key;
      const current = textRef.current;
      if (current.trim()) {
        // Typed before the store hydrated: save it now, the change already passed.
        scheduleComposerDraftWrite(key, current);
        return;
      }
      const stored = readComposerDraft(key);
      if (!stored) return;
      pendingRestore.current = stored;
      setText(stored);
    };
    if (useComposerDraftStore.persist.hasHydrated()) {
      restore();
      return;
    }
    return useComposerDraftStore.persist.onFinishHydration(restore);
  }, [key, setText]);

  useEffect(() => {
    if (!key || restoredFor.current !== key) return;
    if (pendingRestore.current !== null) {
      // Until the restored text renders, `text` is the pre-restore '' — a
      // write now would delete the draft being restored. Once it renders,
      // the store already holds it.
      if (text === pendingRestore.current) pendingRestore.current = null;
      return;
    }
    scheduleComposerDraftWrite(key, text);
  }, [key, text]);
}
