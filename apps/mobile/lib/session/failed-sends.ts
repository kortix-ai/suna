/**
 * Failed sends (COR-143): a thread message whose prompt never reached the
 * runtime. The optimistic user message stays in the thread, dimmed, with
 * "Not sent · Try again"; this store keeps what a retry sends again. Web keeps
 * a failed accepted send on screen the same way (`uploadStatus` on
 * `apps/web/src/features/session/turn/user-message.tsx`).
 *
 * In memory only: the payload is the text as sent, the send options, and —
 * once a message could carry attachments (COR-185) — the prompt's file parts
 * (`fileParts`, `lib/session/prompt-parts.ts`) plus the picked files
 * (`localFiles`) that made them, so a retry re-posts the same upload handles
 * through `createSessionPrompt` rather than re-uploading. An unbound upload
 * lives 24 h on the server (`packages/sdk/src/core/attachments/
 * prompt-attachments.ts`), so a retry inside that window still finds it.
 */

import { create } from 'zustand';
import type { SessionPromptPart } from '@kortix/sdk';
import type { AttachedFile } from './attachments';

export interface FailedSend<TOptions = unknown, TMentions = unknown> {
  /** The text `handleSend` was called with (attachment refs included). */
  text: string;
  options: TOptions;
  mentions?: TMentions;
  /** The uploaded file parts a retry re-posts as-is. */
  fileParts?: SessionPromptPart[];
  /** The picked files behind `fileParts`, for the composer's tiles on retry. */
  localFiles?: AttachedFile[];
  /**
   * The ids the failed attempt sent. A retry sends the same ids: the prompt
   * inbox dedupes on `clientMessageId`, so an attempt that reached the server
   * before its response was lost does not run the prompt twice.
   */
  clientMessageId?: string;
  messageId?: string;
}

export interface SendIds {
  clientMessageId: string;
  messageId: string;
}

/** The ids of one send: a retry's kept ids, each missing one minted fresh. */
export function sendIdsFor(retry: Partial<SendIds> | undefined, mint: () => SendIds): SendIds {
  if (retry?.clientMessageId && retry.messageId) {
    return { clientMessageId: retry.clientMessageId, messageId: retry.messageId };
  }
  const fresh = mint();
  return {
    clientMessageId: retry?.clientMessageId ?? fresh.clientMessageId,
    messageId: retry?.messageId ?? fresh.messageId,
  };
}

type BySession = Record<string, Record<string, FailedSend>>;

interface FailedSendState {
  /** session id → optimistic message id → payload */
  bySession: BySession;
  markFailed: (sessionId: string, messageId: string, send: FailedSend) => void;
  /** Removes and returns the payload; undefined when absent (a double tap). */
  take: (sessionId: string, messageId: string) => FailedSend | undefined;
}

export function withFailed(state: BySession, sessionId: string, messageId: string, send: FailedSend): BySession {
  return { ...state, [sessionId]: { ...state[sessionId], [messageId]: send } };
}

export function withoutFailed(state: BySession, sessionId: string, messageId: string): BySession {
  const session = state[sessionId];
  if (!session || !(messageId in session)) return state;
  const nextSession = { ...session };
  delete nextSession[messageId];
  const next = { ...state };
  if (Object.keys(nextSession).length > 0) next[sessionId] = nextSession;
  else delete next[sessionId];
  return next;
}

export const useFailedSendStore = create<FailedSendState>((set, get) => ({
  bySession: {},
  markFailed: (sessionId, messageId, send) =>
    set((state) => ({ bySession: withFailed(state.bySession, sessionId, messageId, send) })),
  take: (sessionId, messageId) => {
    const send = get().bySession[sessionId]?.[messageId];
    if (!send) return undefined;
    set((state) => ({ bySession: withoutFailed(state.bySession, sessionId, messageId) }));
    return send;
  },
}));

const EMPTY: Record<string, FailedSend> = {};

/** The failed sends of one session, by message id. Stable when empty. */
export function useFailedSends(sessionId: string): Record<string, FailedSend> {
  return useFailedSendStore((state) => state.bySession[sessionId] ?? EMPTY);
}
