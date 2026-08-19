import type { AttachedFile } from '@/features/session/session-chat-input';
import { create } from 'zustand';

interface PendingFilesState {
  files: AttachedFile[];
  setPendingFiles: (files: AttachedFile[]) => void;
  consumePendingFiles: () => AttachedFile[];
}

export const usePendingFilesStore = create<PendingFilesState>((set, get) => ({
  files: [],
  setPendingFiles: (files) => set({ files }),
  consumePendingFiles: () => {
    const files = get().files;
    set({ files: [] });
    return files;
  },
}));

export interface CarriedDraft {
  text: string;
  files: AttachedFile[];
  /** Bumped per carry, so the composer's id-keyed prefill effect applies each
   *  new one exactly once. */
  id: number;
}

interface CarriedDraftState {
  /** Kortix session id → the draft waiting to be handed to that session's
   *  real composer. */
  draftBySession: Record<string, CarriedDraft>;
  carryDraft: (sessionId: string, text: string, files: AttachedFile[]) => void;
  /** Called once the composer has been handed this draft. Held rather than
   *  consumed on read — the composer's own id-keyed prefill effect is what
   *  makes ONE application one-shot — but held forever would ghost the text
   *  back into an emptied editor on the next remount (tab switch, panel
   *  toggle). Same shape as `clearPrefill` in
   *  `session-composer-prefill-store.ts`, for the same reason. */
  clearCarriedDraft: (sessionId: string) => void;
}

let nextCarriedDraftId = 0;

/**
 * A draft that has to survive ONE component being replaced by another.
 *
 * The instant boot shell refuses a second message while the first is still
 * starting — a row POSTed then would be admitted before the first message,
 * which is still travelling through the start stash and is not an inbox row
 * yet. The refusal is a throw, and the composer's own recovery puts the text
 * back in the editor. That editor is the SHELL's, and the shell is unmounted
 * by the crossfade the moment the sandbox is ready — so the recovered draft
 * died with it, after a toast that promised it was kept. The boot it dies at
 * the end of is 19-25 s (measured), which is exactly when a follow-up gets
 * typed.
 *
 * So the refusal also carries the draft here, keyed by the session, and
 * `SessionChat` picks it up when it mounts. Nothing is SENT — the ordering
 * rule that makes the refusal correct is untouched — the text just outlives
 * the component that was holding it.
 */
export const useCarriedDraftStore = create<CarriedDraftState>((set) => ({
  draftBySession: {},
  carryDraft: (sessionId, text, files) =>
    set((s) => ({
      draftBySession: {
        ...s.draftBySession,
        [sessionId]: { text, files, id: ++nextCarriedDraftId },
      },
    })),
  clearCarriedDraft: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.draftBySession)) return s;
      const { [sessionId]: _removed, ...rest } = s.draftBySession;
      return { draftBySession: rest };
    }),
}));

/** The draft waiting for this session's composer, keyed by the KORTIX session
 *  id — the one id both the boot shell and `SessionChat` hold. */
export const useCarriedDraft = (sessionId: string): CarriedDraft | null =>
  useCarriedDraftStore((s) => s.draftBySession[sessionId] ?? null);

// `usePendingQueueStore` used to live here: a single global list of messages
// typed in the instant shell, consumed once by whichever `SessionChat` mounted
// first. It carried no session id, so a message queued for one session could
// be handed to another. Its replacement — a per-session browser queue — is gone
// too: the queue is the server's prompt inbox, keyed by the Kortix session id,
// so there is no handoff, nothing to consume, and nothing a closed tab loses.
