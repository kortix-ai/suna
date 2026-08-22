'use client';

/**
 * "Ask for changes" (W12) — a deliverable hands the composer a starter line.
 * Session-scoped sibling of `composer-prefill-store.ts` (which is project-home
 * only). Not one-shot: `SessionChatInput`'s prefill effect keys on `id`, so a
 * held value re-applies only when a new set bumps it.
 *
 * "Add context" (Task 5) reuses the exact same held/id-keyed handoff shape for
 * a different ask: not text to insert, just "open your attach flow". It gets
 * its own record rather than overloading `prefillBySession` — the two events
 * are independent (either can fire without the other) and a prefill's `text`
 * has no analogue here.
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

  /** sessionId → an incrementing marker asking the composer to open its
   *  attach (file-picker) flow. Same held-then-cleared shape as the prefill
   *  above and for the same reason: held forever would re-open the file
   *  picker on every later remount (tab switch, panel toggle) of a composer
   *  that never actually asked for it this time. */
  attachRequestBySession: Record<string, number>;
  /** The empty Context card's "Add context" button calls this — see
   *  `context-card.tsx` / `easy-panel.tsx`. */
  requestAttach: (sessionId: string) => void;
  /** Called once the composer has opened the picker for this request —
   *  removes it so a later remount doesn't re-open it. */
  clearAttachRequest: (sessionId: string) => void;
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

  attachRequestBySession: {},
  requestAttach: (sessionId) =>
    set((s) => ({
      attachRequestBySession: { ...s.attachRequestBySession, [sessionId]: ++nextId },
    })),
  clearAttachRequest: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.attachRequestBySession)) return s;
      const { [sessionId]: _removed, ...rest } = s.attachRequestBySession;
      return { attachRequestBySession: rest };
    }),
}));

export const useSessionPrefill = (sessionId: string): SessionPrefill | null =>
  useSessionComposerPrefillStore((s) => s.prefillBySession[sessionId] ?? null);

export const useAttachRequest = (sessionId: string): number | null =>
  useSessionComposerPrefillStore((s) => s.attachRequestBySession[sessionId] ?? null);
