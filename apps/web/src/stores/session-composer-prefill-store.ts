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
  /** sessionId → the latest prefill for that session. Held, not consumed by
   *  the composer's own id-keyed effect (that's what makes ONE APPLICATION
   *  one-shot) — but held forever would mean every later remount of
   *  SessionChat (tab switch, panel toggle) re-hands the SAME value to a
   *  freshly-mounted composer, whose prefill effect sees a "new" id it has
   *  never applied and stuffs the old text back into the textarea, ghosting
   *  over whatever the user typed since. `clearPrefill` is how the session
   *  (not the composer) declares "already delivered, forget it". */
  prefillBySession: Record<string, SessionPrefill>;
  setPrefill: (sessionId: string, text: string) => void;
  /** Called once the composer has been handed this session's prefill —
   *  removes it so a later remount doesn't re-apply stale text. */
  clearPrefill: (sessionId: string) => void;
}

let nextId = 0;

export const useSessionComposerPrefillStore = create<SessionComposerPrefillState>((set) => ({
  prefillBySession: {},
  setPrefill: (sessionId, text) =>
    set((s) => ({
      prefillBySession: { ...s.prefillBySession, [sessionId]: { text, id: ++nextId } },
    })),
  clearPrefill: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.prefillBySession)) return s;
      const { [sessionId]: _removed, ...rest } = s.prefillBySession;
      return { prefillBySession: rest };
    }),
}));

export const useSessionPrefill = (sessionId: string): SessionPrefill | null =>
  useSessionComposerPrefillStore((s) => s.prefillBySession[sessionId] ?? null);
