'use client';

import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';

import { errorToast } from '@/components/ui/toast';
import { errorMessageOf } from '@/lib/delivered-but-disconnected';
import { neutralizePastedTags } from '@kortix/shared';

import type { QueueRow } from './queue-projection';

/**
 * Editing a queued message in place — the one implementation the chat and the
 * boot shell (`instant-session-shell.tsx`) share.
 *
 * Edit (the pencil, or Up in an empty composer) opens a queued row's words in
 * the composer and sends no request: the row stays queued on the server, in its
 * place, with its files. Submit saves the new words into that same row
 * (`PATCH .../prompts/:id`, which keeps every non-text part); it never sends a
 * new message. Cancel touches nothing.
 *
 * The shell used to take a row back by deleting it and refilling the composer
 * with its text parts only, so every file on the message was lost.
 */

/** A queued message open in the composer. */
export interface QueuedPromptEdit {
  promptId: string;
  clientMessageId?: string;
  /** The row's whole text as the server holds it: file and mention markup included. */
  rawText: string;
  /** The words the composer edits — one verbatim run of `rawText`. */
  editText: string;
}

interface QueuedPromptEditState {
  /** Project session id (the key the prompt inbox uses) → the open edit. */
  edits: Record<string, QueuedPromptEdit>;
}

/**
 * A store, not component state. During boot the shell and the chat draw the
 * same session's queue, and the shell hands over to the chat while an edit may
 * be open. Held by either component alone, the edit would end at the hand-over
 * and the chat would send the edited words as a NEW message beside the
 * untouched original.
 */
export const useQueuedPromptEditStore = create<QueuedPromptEditState>(() => ({ edits: {} }));

function openEdit(key: string): QueuedPromptEdit | undefined {
  return useQueuedPromptEditStore.getState().edits[key];
}

function setEdit(key: string, edit: QueuedPromptEdit | null): void {
  useQueuedPromptEditStore.setState((state) => {
    const edits = { ...state.edits };
    if (edit) edits[key] = edit;
    else delete edits[key];
    return { edits };
  });
}

/** What a host (the chat, the boot shell) hands the shared edit. */
export interface QueuedPromptEditHost {
  /** The project session id. */
  key: string;
  /** The queue as drawn now. Read at call time. */
  rows: () => readonly QueueRow[];
  /** `useSessionPrompts().edit`. */
  editPrompt: (promptId: string, text: string) => Promise<unknown>;
  /** Replace the composer's text. */
  setComposerText: (text: string) => void;
  /** Drop this tab's own copy of a sent message, whose text outranks the row's. */
  forgetLocalDraft?: (clientMessageId: string) => void;
  onError: (message: string) => void;
}

/**
 * Open a queued row in the composer: `promptId`, or the latest editable row
 * when none is given. Returns whether it acted, synchronously — the composer
 * keeps Up as a caret move when there is nothing to edit.
 */
export function takeBackQueuedPrompt(host: QueuedPromptEditHost, promptId?: string): boolean {
  // One edit at a time: the composer holds one draft.
  if (openEdit(host.key)) return false;
  const target = host
    .rows()
    .filter((row) => row.takeBackEligible && (!promptId || row.id === promptId))
    .at(-1);
  if (!target?.editText) return false;
  setEdit(host.key, {
    promptId: target.id,
    ...(target.clientMessageId ? { clientMessageId: target.clientMessageId } : {}),
    rawText: target.rawText,
    editText: target.editText,
  });
  host.setComposerText(target.editText);
  return true;
}

/** Cancel: the row was never touched, so only the composer empties. */
export function cancelQueuedPromptEdit(host: QueuedPromptEditHost): void {
  if (!openEdit(host.key)) return;
  setEdit(host.key, null);
  host.setComposerText('');
}

/**
 * Submit while editing: the new words replace the old ones inside the row's raw
 * text, so a quote, a mention or a file reference around them survives, and the
 * row is PATCHed in place. Nothing is sent — a re-POST would release a Stop hold
 * and run at once on an idle session.
 *
 * Returns `false` when no edit is open: the composer then sends as usual.
 */
export async function saveQueuedPromptEdit(
  host: QueuedPromptEditHost,
  text: string,
): Promise<boolean> {
  const edit = openEdit(host.key);
  if (!edit) return false;
  setEdit(host.key, null);
  // The LAST match: the composer writes quotes and pastes ahead of the typed
  // words, so an earlier match can sit inside a paste body.
  // `editText` and `text` are display text: in the raw wire text their typed
  // `<pasted_content` tags are escaped, and a new one must be escaped too.
  const wireOld = neutralizePastedTags(edit.editText);
  const at = edit.rawText.lastIndexOf(wireOld);
  const next =
    at === -1
      ? edit.rawText
      : edit.rawText.slice(0, at) +
        neutralizePastedTags(text.trim()) +
        edit.rawText.slice(at + wireOld.length);
  if (next === edit.rawText) return true;
  // This tab's own copy of the message outranks the server's row: drop it, so
  // the row shows the edit.
  if (edit.clientMessageId) host.forgetLocalDraft?.(edit.clientMessageId);
  try {
    await host.editPrompt(edit.promptId, next);
  } catch (error) {
    // 409: the agent already has the old text. The new words go back to the
    // composer, never lost.
    host.setComposerText(text);
    host.onError(errorMessageOf(error));
  }
  return true;
}

/**
 * The shared edit, bound to one host. The returned callbacks are stable and
 * read the host's latest values at call time.
 */
export function useQueuedPromptEdit(host: Omit<QueuedPromptEditHost, 'onError'>): {
  /** The open edit, for the queue list's editing row and the Submit label. */
  editing: QueuedPromptEdit | null;
  takeBack: (promptId?: string) => boolean;
  cancel: () => void;
  /** `true` when an edit was open and Submit saved it; send as usual otherwise. */
  save: (text: string) => Promise<boolean>;
} {
  const editing = useQueuedPromptEditStore((state) => state.edits[host.key] ?? null);
  const hostRef = useRef<QueuedPromptEditHost>({ ...host, onError: errorToast });
  useEffect(() => {
    hostRef.current = { ...host, onError: errorToast };
  });
  const takeBack = useCallback((promptId?: string) => takeBackQueuedPrompt(hostRef.current, promptId), []);
  const cancel = useCallback(() => cancelQueuedPromptEdit(hostRef.current), []);
  const save = useCallback((text: string) => saveQueuedPromptEdit(hostRef.current, text), []);
  return { editing, takeBack, cancel, save };
}
