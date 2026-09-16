'use client';

/**
 * The prompts THIS tab queued, as the user typed them — in memory, per session.
 *
 * The queue itself is the server inbox (`useSessionPrompts`). This store holds
 * only what the inbox cannot:
 *
 *  - the row for the upload window. A queued send uploads its files BEFORE it
 *    POSTs, so for that long the inbox has no row at all. The draft is written
 *    on Enter, so the queued list shows the message from the keypress.
 *  - a lossless take-back. The inbox row carries a 2000-char text preview and
 *    sandbox paths for uploaded files; the draft carries the text as typed and
 *    the original `File` objects, which is what the composer needs back.
 *
 * Deliberately not persisted: a reload loses only the enrichment. The inbox
 * still lists every row.
 */

import { create } from 'zustand';
import type { AttachedFile } from '@/features/session/composer/types';

export interface QueuedDraft {
  /** The inbox idempotency key — the id that joins this draft to its row. */
  clientMessageId: string;
  /** The text as typed, before reply context, uploads, or mention blocks. */
  text: string;
  files: AttachedFile[];
  createdAtMs: number;
  /** `POST .../prompts` has resolved; from here the inbox lists the row. */
  posted: boolean;
}

interface QueuedDraftState {
  bySession: Record<string, readonly QueuedDraft[]>;
  add: (sessionId: string, draft: QueuedDraft) => void;
  markPosted: (sessionId: string, clientMessageId: string) => void;
  remove: (sessionId: string, clientMessageIds: readonly string[]) => void;
  /**
   * Drop every POSTED draft whose row the inbox no longer lists — it was
   * delivered, removed elsewhere, or taken back. An unposted draft is kept: its
   * row does not exist yet.
   */
  prune: (sessionId: string, listedClientMessageIds: ReadonlySet<string>) => void;
}

const EMPTY: readonly QueuedDraft[] = [];

function withSession(
  state: QueuedDraftState,
  sessionId: string,
  next: readonly QueuedDraft[],
): Pick<QueuedDraftState, 'bySession'> {
  if (next.length > 0) return { bySession: { ...state.bySession, [sessionId]: next } };
  const { [sessionId]: _removed, ...rest } = state.bySession;
  return { bySession: rest };
}

export const useQueuedDraftStore = create<QueuedDraftState>((set) => ({
  bySession: {},
  add: (sessionId, draft) =>
    set((s) => withSession(s, sessionId, [...(s.bySession[sessionId] ?? EMPTY), draft])),
  markPosted: (sessionId, clientMessageId) =>
    set((s) => {
      const drafts = s.bySession[sessionId];
      if (!drafts?.some((d) => d.clientMessageId === clientMessageId && !d.posted)) return s;
      return withSession(
        s,
        sessionId,
        drafts.map((d) => (d.clientMessageId === clientMessageId ? { ...d, posted: true } : d)),
      );
    }),
  remove: (sessionId, clientMessageIds) =>
    set((s) => {
      const drafts = s.bySession[sessionId];
      if (!drafts?.some((d) => clientMessageIds.includes(d.clientMessageId))) return s;
      return withSession(
        s,
        sessionId,
        drafts.filter((d) => !clientMessageIds.includes(d.clientMessageId)),
      );
    }),
  prune: (sessionId, listedClientMessageIds) =>
    set((s) => {
      const drafts = s.bySession[sessionId];
      if (!drafts) return s;
      const kept = drafts.filter((d) => !d.posted || listedClientMessageIds.has(d.clientMessageId));
      return kept.length === drafts.length ? s : withSession(s, sessionId, kept);
    }),
}));

export const useQueuedDrafts = (sessionId: string): readonly QueuedDraft[] =>
  useQueuedDraftStore((s) => s.bySession[sessionId] ?? EMPTY);
