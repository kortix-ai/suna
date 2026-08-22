'use client';

import type { JSONContent } from '@tiptap/core';
import { type RefObject, useCallback, useEffect, useRef } from 'react';

import { useAuth } from '@/features/providers/auth-provider';

import type { ComposerEditorHandle } from '../editor/composer-editor';
import type { AttachedFile } from '../types';
import {
  type DraftScope,
  type StoredDraft,
  draftScopeKey,
  serializeDraft,
  shouldRestoreDraft,
} from './composer-draft';
import { clearDraft, readDraft, writeDraft } from './composer-draft-store';

/**
 * How long after the last keystroke the draft is written. Long enough that a
 * fast typist produces one write per pause rather than one per character,
 * short enough that a crash loses at most this much typing.
 */
const SAVE_DEBOUNCE_MS = 400;

export interface UseComposerDraftInput {
  /** Omitted or null → the composer persists nothing (marketing demo, tests). */
  scope: DraftScope | null | undefined;
  editorRef: RefObject<ComposerEditorHandle | null>;
  /** The editor element exists, so the handle's methods are safe to call. */
  editorReady: boolean;
  attachedFiles: readonly AttachedFile[];
  /** An explicit prefill outranks a stored draft — see `shouldRestoreDraft`. */
  hasPrefill: boolean;
  /** Called once, with the validated draft, when it is this draft's turn. */
  onRestore: (draft: StoredDraft) => void;
}

export interface UseComposerDraftResult {
  /** Wire straight to `ComposerEditor`'s `onDocChange`. */
  handleDocChange: (doc: JSONContent, isEmpty: boolean) => void;
  /** Call on a SUCCESSFUL send. Never on a refusal — those keep the text. */
  clearSavedDraft: () => void;
}

/**
 * Persist and restore the unsent composer draft.
 *
 * The save path never touches React state. `handleDocChange` is called from
 * `ComposerEditor.onDocChange` on every keystroke; all it does is stash the
 * snapshot in a ref and reset a timer. That is deliberate — the composer is
 * render-silent while typing (`editor/composer-editor.tsx`'s `onEmptyChange`
 * contract) and lifting the document into state would defeat it.
 */
export function useComposerDraft({
  scope,
  editorRef,
  editorReady,
  attachedFiles,
  hasPrefill,
  onRestore,
}: UseComposerDraftInput): UseComposerDraftResult {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const enabled = !!scope && !!userId;

  // Everything the debounced writer reads, held in refs so the timer callback
  // is created once and always sees current values. Synced in effects, never
  // mutated during render.
  const scopeRef = useRef(scope);
  const userIdRef = useRef(userId);
  const filesRef = useRef(attachedFiles);
  const pendingRef = useRef<{ doc: JSONContent; isEmpty: boolean } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredKeyRef = useRef<string | null>(null);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  useEffect(() => {
    filesRef.current = attachedFiles;
  }, [attachedFiles]);

  /**
   * Write whatever is pending, now.
   *
   * Reads emptiness from the SNAPSHOT, never from `editorRef.current.isEmpty()`:
   * this also runs from the unmount cleanup, and React tears down child effects
   * before parent ones, so by then `ComposerEditor` has already destroyed its
   * TipTap instance. The snapshot's `isEmpty` was read off the live editor in
   * the same tick as its document — see `createUpdateHandler`.
   */
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const activeScope = scopeRef.current;
    const pending = pendingRef.current;
    if (!activeScope || !userIdRef.current || !pending) return;
    pendingRef.current = null;
    writeDraft(
      activeScope,
      serializeDraft({
        doc: pending.doc,
        documentIsEmpty: pending.isEmpty,
        files: filesRef.current,
        userId: userIdRef.current,
      }),
    );
  }, []);

  const handleDocChange = useCallback(
    (doc: JSONContent, isEmpty: boolean) => {
      if (!scopeRef.current || !userIdRef.current) return;
      pendingRef.current = { doc, isEmpty };
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const clearSavedDraft = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    const activeScope = scopeRef.current;
    if (activeScope) clearDraft(activeScope);
  }, []);

  /**
   * Flush on every way a page can go away without unmounting cleanly.
   *
   * `beforeunload` is deliberately absent: iOS Safari does not fire it
   * reliably, and `pagehide` covers the same transition on every browser.
   */
  useEffect(() => {
    if (!enabled) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = () => flush();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      flush();
    };
  }, [enabled, flush]);

  /**
   * Restore, at most once per scope key. `restoredKeyRef` is what makes a
   * remount (tab switch, panel toggle) not ghost a draft back into an editor
   * the user deliberately emptied.
   */
  useEffect(() => {
    if (!scope || !userId) return;
    const key = draftScopeKey(scope);
    if (
      !shouldRestoreDraft({
        editorReady,
        editorIsEmpty: editorRef.current?.isEmpty() ?? true,
        hasPrefill,
        alreadyRestored: restoredKeyRef.current === key,
      })
    ) {
      return;
    }
    restoredKeyRef.current = key;
    const stored = readDraft(scope, userId);
    if (stored) onRestore(stored);
  }, [scope, userId, editorReady, hasPrefill, editorRef, onRestore]);

  return { handleDocChange, clearSavedDraft };
}
