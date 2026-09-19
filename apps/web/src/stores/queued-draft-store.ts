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

import type { AttachedFile } from '@/features/session/composer/types';
import { create } from 'zustand';

export interface QueuedDraft {
  placement?: 'transcript' | 'composer';
  /** The inbox idempotency key — the id that joins this draft to its row. */
  clientMessageId: string;
  /**
   * The WIRE message id this send went out under (`mintSessionWireMessageId`),
   * kept because it is the key `useHeldSendFailureStore` holds this send's
   * failure by. It is stored, never re-derived: the mint memoizes in a module
   * Map capped at 256 pairs and evicts the oldest, so deriving it later can
   * hand back a different id and lose the failure.
   *
   * Absent only for a producer that keeps no held send — `InstantSessionShell`
   * builds throwaway drafts for the projection and passes no failures.
   */
  messageId?: string;
  /** The text as typed, before reply context, uploads, or mention blocks. */
  text: string;
  files: AttachedFile[];
  createdAtMs: number;
  /** `POST .../prompts` has resolved; from here the inbox lists the row. */
  posted: boolean;
}

interface QueuedDraftState {
  bySession: Record<string, readonly QueuedDraft[]>;
  /**
   * Write this session's draft for one submission. An UPSERT keyed by
   * `clientMessageId`: a Retry re-enters `handleSend` with the same key, and
   * appending would list the message twice under one React key. The original
   * `createdAtMs` is kept, because the queue is ordered by when the user sent
   * it, not by when they retried.
   */
  add: (sessionId: string, draft: QueuedDraft) => void;
  markPosted: (sessionId: string, clientMessageId: string) => void;
  remove: (sessionId: string, clientMessageIds: readonly string[]) => void;
  /** An in-place edit saved new words: the draft shows them, and keeps its
   *  files and its place. */
  setText: (sessionId: string, clientMessageId: string, text: string) => void;
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
    set((s) => {
      const drafts = s.bySession[sessionId] ?? EMPTY;
      const existing = drafts.find((d) => d.clientMessageId === draft.clientMessageId);
      if (!existing) return withSession(s, sessionId, [...drafts, draft]);
      const merged = { ...draft, createdAtMs: existing.createdAtMs };
      return withSession(
        s,
        sessionId,
        drafts.map((d) => (d.clientMessageId === draft.clientMessageId ? merged : d)),
      );
    }),
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
  setText: (sessionId, clientMessageId, text) =>
    set((s) => {
      const drafts = s.bySession[sessionId];
      if (!drafts?.some((d) => d.clientMessageId === clientMessageId)) return s;
      return withSession(
        s,
        sessionId,
        drafts.map((d) => (d.clientMessageId === clientMessageId ? { ...d, text } : d)),
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
