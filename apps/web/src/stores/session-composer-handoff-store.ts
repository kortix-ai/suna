import type { AttachmentSubmission } from '@/features/session/composer/attachment-submission';
import { rememberFirstPromptAttachments } from '@/features/session/sent-attachment-previews';
import type { AttachedFile, TrackedMention } from '@/features/session/session-chat-input';
import type { AttachmentUploadStatus } from '@/features/session/turn/user-message';
import { sentAttachmentsOf } from '@/features/session/uploaded-file-refs';
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

interface FirstPromptPreviewState {
  /** Kortix session id → the first prompt's text, for RENDER only. */
  previewBySession: Record<
    string,
    { text: string; files: AttachedFile[]; uploadStatus?: AttachmentUploadStatus }
  >;
  setFirstPromptPreview: (
    sessionId: string,
    text: string,
    files: AttachedFile[],
    uploadStatus?: AttachmentUploadStatus,
  ) => void;
  clearFirstPromptPreview: (sessionId: string) => void;
}

/**
 * The first prompt, as the boot shell should draw it the instant the session
 * page mounts.
 *
 * The prompt itself is DURABLE before navigation — a create-time
 * `pending_prompt` row, or the warm claim's row — and nothing here is ever
 * sent. But the shell learns about that row by fetching it, and a warm box
 * can deliver it in the seconds between navigation and that fetch; the row is
 * then gone, the transcript has not loaded yet, and the shell drew nothing
 * for a few seconds after showing the bubble on the home page. This is the
 * in-memory copy the producer leaves for the shell to draw meanwhile — the
 * same text, keyed by the Kortix session id, gone with the tab (a reload has
 * the row or the transcript to read from).
 *
 * A first prompt whose POST waits on its uploads is not durable yet. When that
 * POST cannot be made, its producer leaves the failed status here, with Retry.
 */
export const useFirstPromptPreviewStore = create<FirstPromptPreviewState>((set) => ({
  previewBySession: {},
  setFirstPromptPreview: (sessionId, text, files, uploadStatus) => {
    // Outlives this preview: the first turn and the shell keep the sent pictures after the clear.
    rememberFirstPromptAttachments(sessionId, sentAttachmentsOf(files));
    set((s) => ({
      previewBySession: {
        ...s.previewBySession,
        [sessionId]: { text, files, ...(uploadStatus ? { uploadStatus } : {}) },
      },
    }));
  },
  clearFirstPromptPreview: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.previewBySession)) return s;
      const { [sessionId]: _removed, ...rest } = s.previewBySession;
      return { previewBySession: rest };
    }),
}));

/** One follow-up send, in the arguments `SessionChat.handleSend` takes, kept to send again. */
export interface HeldSend {
  text: string;
  files?: AttachedFile[];
  mentions?: TrackedMention[];
  attachments: AttachmentSubmission;
  overrides: {
    agent?: string | null;
    model?: { providerID: string; modelID: string } | null;
    variant?: string | null;
    /** The same inbox key on Retry, so the wire id and the bubble stay the same. */
    clientMessageId: string;
  };
}

export interface HeldSendFailure {
  message: string;
  send: HeldSend;
}

interface HeldSendFailureState {
  /** Kortix session id → message id → the painted send whose upload failed. */
  failuresBySession: Record<string, Record<string, HeldSendFailure>>;
  setHeldSendFailure: (sessionId: string, messageId: string, failure: HeldSendFailure) => void;
  clearHeldSendFailure: (sessionId: string, messageId: string) => void;
}

/**
 * Follow-up sends whose uploads failed after the bubble was painted.
 *
 * The bubble lives in the global sync store and is inbox-backed, so it outlives
 * `SessionChat`. Its failure must outlive it too: a remount (session switch and
 * return) otherwise draws a message that was never POSTed as sent, with no
 * Retry. The entry holds data, not a closure, so Retry runs through the
 * `SessionChat` on screen.
 */
export const useHeldSendFailureStore = create<HeldSendFailureState>((set) => ({
  failuresBySession: {},
  setHeldSendFailure: (sessionId, messageId, failure) =>
    set((s) => ({
      failuresBySession: {
        ...s.failuresBySession,
        [sessionId]: { ...s.failuresBySession[sessionId], [messageId]: failure },
      },
    })),
  clearHeldSendFailure: (sessionId, messageId) =>
    set((s) => {
      const failures = s.failuresBySession[sessionId];
      if (!failures || !(messageId in failures)) return s;
      const { [messageId]: _removed, ...rest } = failures;
      const { [sessionId]: _session, ...others } = s.failuresBySession;
      return {
        failuresBySession: Object.keys(rest).length > 0 ? { ...others, [sessionId]: rest } : others,
      };
    }),
}));

/**
 * Retry of a kept send, run when the user clicks Retry. It restarts the failed
 * uploads (same `attachment_id`; finished uploads are not sent again), then
 * calls `resend`. An upload that cannot restart keeps the send failed with
 * that reason. A message with no kept failure sends nothing, so a second click
 * cannot send twice.
 */
export function retryHeldSend(
  sessionId: string,
  messageId: string,
  resend: (send: HeldSend) => Promise<unknown>,
  describe: (error: unknown) => string,
): void {
  const store = useHeldSendFailureStore.getState();
  const failure = store.failuresBySession[sessionId]?.[messageId];
  if (!failure) return;
  store.clearHeldSendFailure(sessionId, messageId);
  try {
    failure.send.attachments.retry();
  } catch (error) {
    store.setHeldSendFailure(sessionId, messageId, { message: describe(error), send: failure.send });
    return;
  }
  // A failed POST is surfaced by the send path itself.
  void resend(failure.send).catch(() => {});
}

// `usePendingQueueStore` used to live here: a single global list of messages
// typed in the instant shell, consumed once by whichever `SessionChat` mounted
// first. It carried no session id, so a message queued for one session could
// be handed to another. Its replacement — a per-session browser queue — is gone
// too: the queue is the server's prompt inbox, keyed by the Kortix session id,
// so there is no handoff, nothing to consume, and nothing a closed tab loses.
