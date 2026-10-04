'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { errorToast } from '@/components/ui/toast';
import type { ComposerOptions } from '@/features/session/composer-chat-input';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { isFirstPromptRow } from '@/features/session/queue-projection';
import type { AttachmentUploadStatus } from '@/features/session/turn/user-message';
import { promptFileParts, sentAttachmentsOf } from '@/features/session/uploaded-file-refs';
import {
  firstPromptAttachments,
  type SentAttachment,
} from '@/features/session/sent-attachment-previews';
import {
  deliversDetached,
  postWhenUploaded,
  sentFailureMessage,
  type AttachmentSubmission,
} from '@/features/session/composer/attachment-submission';
import { deliverInOrder } from '@/features/session/composer/delivery-chain';
import { playSound } from '@/lib/sounds';
import {
  useFirstPromptPreviewStore,
  usePendingFilesStore,
} from '@/stores/session-composer-handoff-store';
import { useTranslations } from '@/i18n/use-translations';
import type { SessionPromptOverrides, SessionPromptPart } from '@kortix/sdk';
import {
  mintSessionWireMessageId,
  readStartStash,
  startSessionWithPrompt,
  writeStartStash,
  type UseSessionPromptsResult,
} from '@kortix/sdk/react';

/** One candidate first prompt: the text, the files this tab holds, the stable
 *  attachment identities a bubble draws and the failed-upload status. */
export interface FirstPromptSubmission {
  text: string;
  files: AttachedFile[];
  attachments?: ReadonlyArray<SentAttachment>;
  uploadStatus?: AttachmentUploadStatus;
}

/**
 * The four sources, resolved so ATTACHMENTS ARE NEVER LOST.
 *
 * This was a plain `??` chain, and the durable row sat ahead of the stash.
 * The row is the cross-navigation truth for TEXT, but it never carries the
 * user's `File`s — this tab may not have sent it. So on the one navigation
 * people make most (home composer → new session) the row would land first,
 * win, and drop three attachments the stash was still holding: the bubble
 * appeared with the prompt and no tiles, and the files only reappeared
 * minutes later when the runtime finally echoed the message. First-non-null
 * let the POOREST source win.
 *
 * Text still follows the old precedence. Files are taken from whichever
 * source actually has them, and the row's attachment NAMES are the fallback
 * for a tab that never held the bytes (a reload).
 */
export function resolveFirstPromptSubmission(input: {
  /** The tab's own first send, painted before its POST. */
  submission: FirstPromptSubmission | null;
  /** The producer's first-frame copy, from `useFirstPromptPreviewStore`. */
  previewSubmission: FirstPromptSubmission | null;
  /** The durable first-prompt inbox row, from `useSessionPrompts`. */
  pendingRowSubmission: FirstPromptSubmission | null;
  /** The SDK start-stash fallback, from `readStartStash`. */
  stashedSubmission: FirstPromptSubmission | null;
  /** The first prompt's sent identities retained across the preview clear. */
  rememberedAttachments?: ReadonlyArray<SentAttachment>;
}): FirstPromptSubmission | null {
  const { submission, previewSubmission, pendingRowSubmission, stashedSubmission, rememberedAttachments } =
    input;
  const textSource = submission ?? previewSubmission ?? pendingRowSubmission ?? stashedSubmission;
  const localFiles = submission?.files.length
    ? submission.files
    : previewSubmission?.files.length
      ? previewSubmission.files
      : (stashedSubmission?.files ?? []);
  return textSource
    ? {
        text: textSource.text,
        files: localFiles,
        // Only when this tab holds no bytes of its own — otherwise the local
        // files already draw every tile and these names would double them.
        // This tab's first prompt keeps its sent identities (and so its pictures)
        // after the preview store drops its copy.
        attachments:
          localFiles.length > 0
            ? []
            : (rememberedAttachments ?? pendingRowSubmission?.attachments ?? []),
        // A first prompt held on its uploads carries its own failed status;
        // otherwise the row's, so a real failed send remains visible.
        uploadStatus: previewSubmission?.uploadStatus ?? pendingRowSubmission?.uploadStatus,
      }
    : null;
}

/** The tab's own first send, painted before its POST. */
type LocalSubmission = {
  text: string;
  files: AttachedFile[];
};

/** Every send AFTER the first, painted the moment Enter lands. */
type ExtraSend = {
  id: string;
  text: string;
  files: AttachedFile[];
  placement: 'transcript' | 'composer';
  attachments?: ReadonlyArray<SentAttachment>;
  uploadStatus?: AttachmentUploadStatus;
};

type Words = ReturnType<typeof useTranslations>;

/** One send at Enter: the request as the composer handed it over, plus the
 *  facts the flow derives before the first await. */
interface SendRequest {
  projectId: string;
  sessionId: string;
  text: string;
  files: AttachedFile[] | undefined;
  options: ComposerOptions;
  attachments?: AttachmentSubmission;
  sentAtMs: number;
  first: boolean;
  detached: boolean;
  clientMessageId: string;
  messageId: string;
  placement: 'transcript' | 'composer';
  overrides: SessionPromptOverrides;
}

/** The handles one send touches: the hook's state setters and refs, the inbox
 *  it POSTs through, the page hand-off and the words it toasts with. */
interface SendEnv {
  onSubmit?: () => void;
  enqueue: UseSessionPromptsResult['enqueue'];
  tI18nHardcoded: Words;
  tComposerAttachments: Words;
  setSubmission: Dispatch<SetStateAction<LocalSubmission | null>>;
  setExtraSends: Dispatch<SetStateAction<ExtraSend[]>>;
  firstSendInFlight: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
}

function paintSend(send: SendRequest, env: SendEnv): void {
  const { sessionId, text, files, options, placement, clientMessageId, first, detached } = send;
  const { setSubmission, setExtraSends, firstSendInFlight } = env;
  if (first) {
    firstSendInFlight.current = true;
    // Hand the PICKS to the real chat through the stash (it seeds the
    // per-session model/agent stores from them). The prompt itself is a
    // durable inbox row.
    writeStartStash(sessionId, {
      prompt: '',
      agent: options.agent ?? null,
      model: options.model ?? null,
      variant: options.variant ?? null,
    });
    if (detached) {
      playSound('send');
      setSubmission({ text, files: files ?? [] });
    }
  } else {
    playSound('send');
    setExtraSends((prev) => [
      ...prev,
      {
        id: clientMessageId,
        text,
        files: files ?? [],
        placement,
        attachments: sentAttachmentsOf(files ?? []),
      },
    ]);
  }
}

/** The POST every delivery of this send runs: the first prompt through
 *  `startSessionWithPrompt`, every later one through the inbox. */
function buildPost(
  send: SendRequest,
  env: Pick<SendEnv, 'enqueue'>,
): (attachmentParts: SessionPromptPart[]) => Promise<void> {
  const {
    text,
    files,
    projectId,
    sessionId,
    first,
    sentAtMs,
    overrides,
    clientMessageId,
    messageId,
    placement,
  } = send;
  const { enqueue } = env;
  const post = async (attachmentParts: SessionPromptPart[]) => {
    const parts = [{ type: 'text' as const, text }, ...promptFileParts(files, attachmentParts)];
    if (first) {
      await startSessionWithPrompt(projectId, sessionId, {
        parts,
        overrides,
        clientSentAtMs: sentAtMs,
      });
      return;
    }
    await enqueue({
      clientMessageId,
      messageId,
      clientSentAtMs: sentAtMs,
      remintOnDelivery: true,
      parts,
      placement,
      overrides,
    });
  };
  return post;
}

/** Deliver a send detached from the composer: see the routing in `handleSend`. */
function deliverDetached(
  send: SendRequest,
  env: SendEnv,
  post: (attachmentParts: SessionPromptPart[]) => Promise<void>,
): void {
  const { sessionId, text, files, attachments, first, clientMessageId } = send;
  const { onSubmit, mountedRef, setExtraSends, tComposerAttachments } = env;
  const describe = (error: unknown) => sentFailureMessage(error, tComposerAttachments);
  if (first) {
    // The first prompt's status lives in the first-prompt preview, which
    // SessionChat also draws, so it survives the crossfade.
    onSubmit?.();
    void postWhenUploaded(
      sessionId,
      attachments,
      post,
      (uploadStatus) =>
        useFirstPromptPreviewStore
          .getState()
          .setFirstPromptPreview(sessionId, text, files ?? [], uploadStatus),
      describe,
    );
    return;
  }
  void postWhenUploaded(
    sessionId,
    attachments,
    post,
    (uploadStatus) => {
      // After the crossfade this shell is gone and cannot draw the status.
      if (uploadStatus && !mountedRef.current)
        errorToast(tComposerAttachments('couldNotSend'), {
          description: uploadStatus.message,
        });
      setExtraSends((prev) =>
        prev.map((extra) => (extra.id === clientMessageId ? { ...extra, uploadStatus } : extra)),
      );
    },
    describe,
  );
}

/** The delivery chain: this send POSTs once every earlier send of the
 *  session has settled. A refusal gives the draft back to the composer that
 *  sent it; an accepted extra send hands its row to the inbox. */
async function deliverInChain(
  send: SendRequest,
  env: SendEnv,
  post: (attachmentParts: SessionPromptPart[]) => Promise<void>,
): Promise<void> {
  const { sessionId, text, files, first, clientMessageId } = send;
  const { onSubmit, setSubmission, setExtraSends, firstSendInFlight, tI18nHardcoded } = env;
  try {
    await deliverInOrder(sessionId, () => post([]));
  } catch (error) {
    // The server never got it. The composer that sent it is still mounted
    // and restores its own draft: the hero composer for a first send, which
    // painted nothing, or the docked one, whose bubble is taken back.
    if (first) firstSendInFlight.current = false;
    else setExtraSends((prev) => prev.filter((extra) => extra.id !== clientMessageId));
    errorToast(
      error instanceof Error
        ? error.message
        : tI18nHardcoded.raw('i18nComplete.text8cea8af247c2'),
    );
    throw error;
  }
  if (first) {
    // Only now does the page mount the real chat: the server holds the prompt.
    playSound('send');
    setSubmission({ text, files: files ?? [] });
    onSubmit?.();
  } else {
    // The inbox lists the accepted row from here on.
    setExtraSends((prev) => prev.filter((extra) => extra.id !== clientMessageId));
  }
}

interface FirstPromptSourcesProps {
  /** The route's session id (== the pending-prompt namespace the page migrates). */
  sessionId: string;
  /** The shell's client-snapshot signal; it gates the start-stash read. */
  hydrated: boolean;
  promptInbox: UseSessionPromptsResult;
  /** The tab's own first send, painted before its POST. */
  submission: LocalSubmission | null;
}

/**
 * Wire the four first-prompt sources together and resolve them. The shell
 * passes its own state in; the resolution itself is the pure
 * {@link resolveFirstPromptSubmission}.
 */
function useFirstPromptSources({
  sessionId,
  hydrated,
  promptInbox,
  submission,
}: FirstPromptSourcesProps): {
  submitted: string | null;
  effectiveSubmission: FirstPromptSubmission | null;
} {
  const stashedSubmission = useMemo(() => {
    if (!hydrated) return null;
    // `readStartStash` covers the canonical SDK stash (written under the route
    // session id by this shell, the project-home composer, and
    // `useConfigureThread` — all three producers now share the one canonical
    // shape) plus its `opencode_pending_prompt` legacy fallback for any other
    // as-yet-unconverted producer.
    const text = readStartStash(sessionId)?.prompt;
    if (!text) return null;
    return {
      text,
      files: usePendingFilesStore.getState().files,
    };
  }, [hydrated, sessionId]);
  const firstPromptRow = promptInbox.prompts.find((p) => isFirstPromptRow(p));
  const pendingRowSubmission = useMemo(() => {
    // A row with NO text is still a real send — an attachment-only prompt is a
    // legal message — so the first row that carries either wins.
    const row = firstPromptRow;
    if (!row) return null;
    // `files` stays empty: this tab never held the bytes. The row's attachment
    // NAMES are what the bubble draws as stable inert tiles, so a reloaded tab
    // shows the same seven files the sending tab did instead of a bare
    // sentence (2026-09-04).
    return {
      text: row.full_text ?? row.text,
      files: [] as AttachedFile[],
      attachments: row.attachments ?? [],
      // Browser upload completed before the row was accepted. The row can
      // still name a failed send, but an undelivered row is not upload progress.
      // `state`, never `last_error` alone: the API writes `last_error` on
      // rows it keeps `queued` and retries, and never clears it on success.
      uploadStatus:
        (row.attachments?.length ?? 0) > 0 && row.state === 'failed'
          ? ({ state: 'failed', ...(row.last_error ? { message: row.last_error } : {}) } as const)
          : undefined,
    };
  }, [firstPromptRow]);
  // The producer's own copy of the first prompt, drawn from the first frame —
  // the row read above can miss it entirely when a warm box delivers between
  // navigation and the fetch. See `useFirstPromptPreviewStore`.
  const previewSubmission = useFirstPromptPreviewStore(
    (s) => s.previewBySession[sessionId] ?? null,
  );
  const effectiveSubmission = resolveFirstPromptSubmission({
    submission,
    previewSubmission,
    pendingRowSubmission,
    stashedSubmission,
    rememberedAttachments: firstPromptAttachments(sessionId),
  });
  const submitted = effectiveSubmission?.text ?? null;
  return { submitted, effectiveSubmission };
}

/** The request as the composer handed it over, plus the facts the flow derives
 *  before the first await. Null for an empty send. */
interface PlanSendInput {
  text: string;
  files: AttachedFile[] | undefined;
  options: ComposerOptions;
  attachments?: AttachmentSubmission;
  projectId: string;
  sessionId: string;
  submitted: string | null;
  firstSendInFlight: RefObject<boolean>;
}

function planSend({
  text,
  files,
  options,
  attachments,
  projectId,
  sessionId,
  submitted,
  firstSendInFlight,
}: PlanSendInput): SendRequest | null {
  if (!text.trim() && !files?.length) return null;
  // Send time, not POST time: the POST may wait on uploads, and the server
  // orders rows by this stamp.
  const sentAtMs = Date.now();
  // Paint first: the bubble is on screen from this frame, whatever the
  // uploads are doing. The durable row is POSTed once every handed-off
  // upload is ready, and every POST of this session leaves in Send order
  // through its delivery chain: a text-only send never overtakes an upload.
  //
  // The first send starts the session. A send typed while the first boots
  // is an inbox row carrying its queue placement, drawn as a Quick Queue
  // bubble or a Queue List row until the row lists it.
  //
  // One exception: a first send that is not detached (no uploads, nothing
  // earlier still delivering) paints after its POST. The hero composer that
  // sent it stays mounted until then, so a refusal leaves the draft, mention
  // chips included, in that composer. A prefill carries text only.
  const first = !submitted && !firstSendInFlight.current;
  // Read before this send joins the session's delivery chain.
  const detached = !!attachments && deliversDetached(sessionId, attachments);
  const clientMessageId = crypto.randomUUID();
  const messageId = mintSessionWireMessageId(sessionId, clientMessageId);
  const placement = options.placement ?? 'transcript';
  const overrides = {
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.variant ? { variant: options.variant } : {}),
  };
  return {
    projectId,
    sessionId,
    text,
    files,
    options,
    attachments,
    sentAtMs,
    first,
    detached,
    clientMessageId,
    messageId,
    placement,
    overrides,
  };
}

/** The send state that outlives renders: the held-send guard, the tab's own
 *  first send, the extra sends painted while the box boots and the one-flight
 *  first-send latch. */
function useSendMemory(): {
  mountedRef: RefObject<boolean>;
  submission: LocalSubmission | null;
  setSubmission: Dispatch<SetStateAction<LocalSubmission | null>>;
  extraSends: ExtraSend[];
  setExtraSends: Dispatch<SetStateAction<ExtraSend[]>>;
  firstSendInFlight: RefObject<boolean>;
} {
  // A held send outlives this shell: the crossfade unmounts it while an upload can still fail.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [submission, setSubmission] = useState<{
    text: string;
    files: AttachedFile[];
  } | null>(null);
  // Every send AFTER the first, painted the moment Enter lands — the durable
  // row takes over on the next poll. Without this the shell drew only the
  // first prompt, and anything typed while the box booted stayed invisible
  // until the real chat mounted (measured: four prompts popping in at once,
  // ~15 s later).
  const [extraSends, setExtraSends] = useState<
    Array<{
      id: string;
      text: string;
      files: AttachedFile[];
      placement: 'transcript' | 'composer';
      attachments?: ReadonlyArray<SentAttachment>;
      uploadStatus?: AttachmentUploadStatus;
    }>
  >([]);
  const firstSendInFlight = useRef(false);
  return { mountedRef, submission, setSubmission, extraSends, setExtraSends, firstSendInFlight };
}

interface UseInstantSessionSendProps {
  projectId: string;
  sessionId: string;
  /** The shell's client-snapshot signal; it gates the start-stash read. */
  hydrated: boolean;
  /** Fired once the first send is durable, or kept on screen by a held send, so the
   *  page can mount the real chat and crossfade it in. */
  onSubmit?: () => void;
  promptInbox: UseSessionPromptsResult;
}

interface UseInstantSessionSendResult {
  submitted: string | null;
  effectiveSubmission: FirstPromptSubmission | null;
  extraSends: ExtraSend[];
  handleSend: (
    text: string,
    files: AttachedFile[] | undefined,
    options: ComposerOptions,
    attachments?: AttachmentSubmission,
  ) => Promise<void>;
}

/**
 * The instant session shell's send orchestration, extracted from the shell so
 * the submission precedence and the send flow are testable without mounting
 * the whole component.
 *
 * Owns the send state (the local first send, the extra sends painted while
 * the box boots, the one-flight guard), resolves the four first-prompt
 * sources through {@link useFirstPromptSources}, and runs each send through
 * paint, detached upload and the session's delivery chain. The shell stays
 * render-only: header, thread, composer.
 */
export function useInstantSessionSend(
  props: UseInstantSessionSendProps,
): UseInstantSessionSendResult {
  const { projectId, sessionId, hydrated, onSubmit, promptInbox } = props;
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tComposerAttachments = useTranslations('hardcodedUi.composerAttachments');
  const { submission, setSubmission, extraSends, setExtraSends, firstSendInFlight, mountedRef } =
    useSendMemory();
  const { submitted, effectiveSubmission } = useFirstPromptSources({
    sessionId,
    hydrated,
    promptInbox,
    submission,
  });

  const handleSend = useCallback(
    async (
      text: string,
      files: AttachedFile[] | undefined,
      options: ComposerOptions,
      attachments?: AttachmentSubmission,
    ) => {
      const send = planSend({
        text,
        files,
        options,
        attachments,
        projectId,
        sessionId,
        submitted,
        firstSendInFlight,
      });
      if (!send) return;
      const env: SendEnv = {
        onSubmit,
        enqueue: promptInbox.enqueue,
        tI18nHardcoded,
        tComposerAttachments,
        setSubmission,
        setExtraSends,
        firstSendInFlight,
        mountedRef,
      };
      paintSend(send, env);
      const post = buildPost(send, env);
      const { detached } = send;
      // A painted send with uploads, or one behind an earlier send of this
      // session, is never taken back, and it never holds the composer: it POSTs
      // from its place in the chain, detached, so the next Send paints at once.
      // A failure marks the message failed, with Retry.
      if (attachments && detached) {
        deliverDetached(send, env, post);
        return;
      }
      await deliverInChain(send, env, post);
    },
    [
      sessionId,
      submitted,
      projectId,
      tI18nHardcoded,
      tComposerAttachments,
      onSubmit,
      promptInbox.enqueue,
      setSubmission,
      setExtraSends,
      firstSendInFlight,
      mountedRef,
    ],
  );

  return { submitted, effectiveSubmission, extraSends, handleSend };
}
