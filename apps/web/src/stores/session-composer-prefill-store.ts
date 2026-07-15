'use client';

/**
 * "Ask for changes" (W12) — a deliverable hands the composer a starter line.
 * Session-scoped sibling of `composer-prefill-store.ts` (which is project-home
 * only). Not one-shot: `SessionChatInput`'s prefill effect keys on `id`, so a
 * held value re-applies only when a new set bumps it.
 */

import { create } from 'zustand';

export interface SessionPrefill {
  text: string;
  id: number;
}

interface SessionComposerPrefillState {
  /** sessionId → the latest prefill for that session. Held, not consumed —
   *  the composer's own id-keyed effect is what makes application one-shot. */
  prefillBySession: Record<string, SessionPrefill>;
  setPrefill: (sessionId: string, text: string) => void;
}

let nextId = 0;

export const useSessionComposerPrefillStore = create<SessionComposerPrefillState>((set) => ({
  prefillBySession: {},
  setPrefill: (sessionId, text) =>
    set((s) => ({
      prefillBySession: { ...s.prefillBySession, [sessionId]: { text, id: ++nextId } },
    })),
}));

export const useSessionPrefill = (sessionId: string): SessionPrefill | null =>
  useSessionComposerPrefillStore((s) => s.prefillBySession[sessionId] ?? null);
