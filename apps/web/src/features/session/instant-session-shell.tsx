'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { errorToast } from '@/components/ui/toast';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import { QueuedPromptList } from '@/features/session/composer/queued-prompt-list';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
import { isFirstPromptRow, projectQueueRows } from '@/features/session/queue-projection';
import { SESSION_TRANSCRIPT_CLASS, SessionBodyRow } from '@/features/session/session-body';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SessionLayout } from '@/features/session/session-layout';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import { SessionWelcome } from '@/features/session/session-welcome';
import {
  QUEUED_BUBBLE_OPACITY_CLASS,
  QueuedPromptFailure,
} from '@/features/session/turn/queued-prompt-bubbles';
import type { AttachmentUploadStatus } from '@/features/session/turn/user-message';
import {
  buildOptimisticPromptTextWithUploads,
  promptFileParts,
  sentAttachmentsOf,
} from '@/features/session/uploaded-file-refs';
import {
  firstPromptAttachments,
  type SentAttachment,
} from '@/features/session/sent-attachment-previews';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  useFirstPromptPreviewStore,
  usePendingFilesStore,
} from '@/stores/session-composer-handoff-store';
import {
  deliversDetached,
  postWhenUploaded,
  sentFailureMessage,
  type AttachmentSubmission,
} from '@/features/session/composer/attachment-submission';
import { deliverInOrder } from '@/features/session/composer/delivery-chain';
import type { SessionPromptOverrides, SessionPromptPart, SessionStartStage } from '@kortix/sdk';
import type { Command } from '@kortix/sdk/react';
import {
  mintSessionWireMessageId,
  readStartStash,
  startSessionWithPrompt,
  usePromptAttachments,
  useRuntimeAgents,
  useSessionPrompts,
  writeStartStash,
} from '@kortix/sdk/react';

const subscribeToNothing = () => () => {};

/**
 * The instant session shell — shown the moment a freshly-created session opens,
 * BEFORE the sandbox/runtime is ready, in place of the old full-screen loader.
 *
 * A faithful, fully-interactive empty session: welcome wallpaper + a live chat
 * input you can type into immediately (the input needs no runtime — the home
 * composer proves it). Provisioning runs silently in the background.
 *
 * On the FIRST send we stash the message on the SDK's canonical start-stash
 * (keyed by the route session id; the session page migrates it onto the
 * OpenCode pin) so the real {@link SessionChat} auto-sends it the instant the
 * runtime is healthy.
 *
 * The thread it paints while waiting is not a lookalike of the real one — it is
 * the real one's {@link OptimisticTurn}, in a scroll area with the same
 * geometry. So the crossfade into {@link SessionChat} has nothing to give it
 * away: same bubble, same waiting row, same position. The row says "Thinking"
 * and keeps saying it until the agent has a real status of its own; the boot
 * stage is reported in the side panel, for anyone who opens it (never
 * auto-opened), and once the runtime is ready the panel falls back to the real
 * (empty) Actions view.
 */
export function InstantSessionShell({
  projectId,
  sessionId,
  stage,
  boundAgentName,
  onSubmit,
  hasTranscript = false,
  draftActive = true,
}: {
  projectId: string;
  /** The route's session id (== the pending-prompt namespace the page migrates). */
  sessionId: string;
  stage: SessionStartStage;
  /** Immutable project-session agent returned by /start. */
  boundAgentName?: string | null;
  /** Fired once the first send is durable, or kept on screen by a held send, so the
   *  page can mount the real chat and crossfade it in. */
  onSubmit?: () => void;
  /**
   * The real chat underneath already holds the prompt in its transcript.
   *
   * This shell dissolves over that chat during the crossfade, and for the
   * length of the fade both are on screen. While the shell still paints its own
   * copy of the prompt, that is two copies — measured 2026-09-08: both
   * stand-ins at full opacity, then the shell's fading over the real bubble.
   * The transcript's copy is the one that stays, so the moment it exists the
   * shell's steps aside. The shell keeps everything else (header, composer,
   * the queued rows behind the first prompt); only the bubble it was standing
   * in for goes.
   */
  hasTranscript?: boolean;
  draftActive?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tComposerAttachments = useTranslations('hardcodedUi.composerAttachments');
  // `ready` is the backend's authoritative "runtime is up" signal (POST /start).
  // Only the side panel reads it now: the thread deliberately shows the SAME
  // waiting row at every boot stage (see below), so there is nothing there to
  // switch on.
  const ready = stage === 'ready';

  // File-mention clicks come from the same store SessionChat reads. Passing the
  // handler here rather than leaving it undefined keeps the bubble identical
  // across the crossfade — an unclickable mention renders as a plain span and
  // would visibly gain an underline the moment the real chat took over.
  // Attachment clicks live inside MessageAttachments (computer store / lightbox).
  const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
  // Same reason: an `@agent` mention only renders as an agent chip when the
  // renderer can recognise the name. Without this list it would fall through to
  // "file" and pick up an underline the real chat does not give it. The catalog
  // query is already in flight — ComposerChatInput below runs the same hook.
  const { data: agents } = useRuntimeAgents({ projectId });
  const agentNames = useMemo(() => (agents ?? []).map((a) => a.name), [agents]);

  // A pending prompt may already be staged (home composer send) → show the
  // booting view immediately in that case.
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
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
  // The durable rows are the cross-navigation truth: a send made on the
  // project home is an inbox row by the time this shell mounts, and reading it
  // from the server is what keeps the bubble on screen after a reload — the
  // stash only carries picks now. The local `submission` covers the same-page
  // send instantly; the stash read stays as a legacy fallback for a hand-off
  // written by a pre-deploy tab.
  const promptInbox = useSessionPrompts(projectId, sessionId, { enabled: hydrated });
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
  const shellQueue = useMemo(
    () =>
      projectQueueRows({
        prompts: promptInbox.prompts,
        drafts: extraSends.map((entry) => ({
          clientMessageId: entry.id,
          text: entry.text,
          files: entry.files,
          placement: entry.placement,
          createdAtMs: 0,
          posted: false,
        })),
      }),
    [promptInbox.prompts, extraSends],
  );
  const transcriptQueue = useMemo(() => {
    const rows = promptInbox.prompts.filter(
      (p) => !isFirstPromptRow(p) && p.placement === 'transcript',
    );
    const listed = new Set(rows.map((p) => p.client_message_id));
    return [
      ...rows.map((p) => ({
        id: p.client_message_id,
        text: p.full_text ?? p.text,
        attachments: p.attachments,
        prompt: p,
      })),
      ...extraSends
        .filter((entry) => entry.placement === 'transcript' && !listed.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          text: buildOptimisticPromptTextWithUploads(entry.text, entry.files),
          attachments: undefined,
          prompt: undefined,
        })),
    ];
  }, [promptInbox.prompts, extraSends]);
  // The producer's own copy of the first prompt, drawn from the first frame —
  // the row read above can miss it entirely when a warm box delivers between
  // navigation and the fetch. See `useFirstPromptPreviewStore`.
  const previewSubmission = useFirstPromptPreviewStore(
    (s) => s.previewBySession[sessionId] ?? null,
  );
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
  const textSource = submission ?? previewSubmission ?? pendingRowSubmission ?? stashedSubmission;
  const localFiles = submission?.files.length
    ? submission.files
    : previewSubmission?.files.length
      ? previewSubmission.files
      : (stashedSubmission?.files ?? []);
  const effectiveSubmission: {
    text: string;
    files: AttachedFile[];
    attachments?: ReadonlyArray<SentAttachment>;
    uploadStatus?: AttachmentUploadStatus;
  } | null = textSource
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
            : (firstPromptAttachments(sessionId) ?? pendingRowSubmission?.attachments ?? []),
        // A first prompt held on its uploads carries its own failed status;
        // otherwise the row's, so a real failed send remains visible.
        uploadStatus: previewSubmission?.uploadStatus ?? pendingRowSubmission?.uploadStatus,
      }
    : null;
  const submitted = effectiveSubmission?.text ?? null;

  // Starter-prompt → composer prefill, identical to the project-home composer.
  const [prefill, setPrefill] = useState<{
    text: string;
    id: number;
    options?: SessionPromptOverrides | null;
    mode?: 'merge';
  } | null>(null);
  // The first send swaps the hero composer for the docked one, which remounts
  // it. The upload controller lives here, so a held send outlives that remount
  // and a failed one can return its uploads to the composer on screen.
  const promptAttachments = usePromptAttachments(projectId);
  const applySuggestion = useCallback((text: string) => {
    setPrefill({ text, id: Date.now() });
  }, []);

  const handleSend = useCallback(
    async (
      text: string,
      files: AttachedFile[] | undefined,
      options: ComposerOptions,
      attachments?: AttachmentSubmission,
    ) => {
      if (!text.trim() && !files?.length) return;
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
        await promptInbox.enqueue({
          clientMessageId,
          messageId,
          clientSentAtMs: sentAtMs,
          remintOnDelivery: true,
          parts,
          placement,
          overrides,
        });
      };
      // A painted send with uploads, or one behind an earlier send of this
      // session, is never taken back, and it never holds the composer: it POSTs
      // from its place in the chain, detached, so the next Send paints at once.
      // A failure marks the message failed, with Retry.
      if (attachments && detached) {
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
        return;
      }
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
    },
    [
      sessionId,
      submitted,
      projectId,
      tI18nHardcoded,
      tComposerAttachments,
      onSubmit,
      promptInbox.enqueue,
    ],
  );

  const handleCommand = useCallback(
    (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      // Defer slash-commands through the same handoff as a normal first message.
      handleSend(`/${cmd.name}${args ? ` ${args}` : ''}`, undefined, options);
    },
    [handleSend],
  );

  // Keyed by the session this shell is booting, so a reload mid-boot finds the
  // same draft the real composer will pick up once it crossfades in.
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'session', sessionId }), [sessionId]);

  // Defined once and slotted into either the hero position (pre-submit, inside
  // the welcome body) or the regular bottom position (post-submit thread view).
  const composerEl = (
    <ComposerChatInput
      onSend={handleSend}
      onCommand={handleCommand}
      promptAttachments={promptAttachments}
      sessionId={sessionId}
      projectId={projectId}
      draftScope={draftScope}
      draftActive={draftActive}
      prefill={prefill}
      onPrefillApplied={(id) => setPrefill((current) => (current?.id === id ? null : current))}
      boundAgentName={boundAgentName}
      // While the computer boots after the first send the input stays fully
      // normal (typeable) — only the send button flips to a stop button. The
      // stop is disabled because there's nothing running to stop yet; the real
      // chat's live stop takes over the instant it crossfades in.
      isBusy={!!submitted}
      // The first message IS the turn as far as this shell is concerned, so a
      // `/` command submitted now is refused with the same message a command
      // typed mid-turn gets, rather than racing the boot.
      sessionWorking={!!submitted}
      stopDisabled={!!submitted}
      // What was typed while the box boots — see `shellQueueRows`.
      inputSlot={
        submitted ? (
          <QueuedPromptList
            rows={shellQueue.rows}
            heldCount={shellQueue.heldCount}
            onResume={() => {
              void promptInbox.hold(false).catch((error) => errorToast(error.message));
            }}
            onRemove={(id) => {
              void promptInbox.remove(id).catch((error) => errorToast(error.message));
            }}
            onRetry={(id) => {
              void promptInbox.retry(id).catch((error) => errorToast(error.message));
            }}
            onEdit={(id) => {
              void promptInbox
                .remove(id)
                .then((removed) => {
                  const text = removed.parts
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('\n');
                  setPrefill({ text, id: Date.now(), mode: 'merge', options: removed.overrides });
                })
                .catch((error) => errorToast(error.message));
            }}
          />
        ) : undefined
      }
      autoFocus
      // Hero radius pre-submit (matches the project home); back to the default
      // card radius once docked so the crossfade into SessionChat doesn't pop.
      cardClassName={submitted ? undefined : 'rounded-xl'}
    />
  );

  const column = (
    <div
      className={cn(
        'relative flex h-full flex-col',
        submitted ? 'bg-background' : 'bg-transparent',
      )}
    >
      {/* Welcome wallpaper — portaled into SessionLayout's full-bleed layer so it
          spans the whole width and never re-crops when the side panel opens
          (identical to a loaded empty session). Hidden once a first message
          exists (the thread takes over on a solid background). */}
      {!submitted && <ShellWallpaper />}

      <SessionSiteHeader
        sessionId={sessionId}
        sessionTitle={tI18nHardcoded.raw(
          'autoFeaturesSessionInstantSessionShellJsxAttrSessionTitleNewSession6b8dfd00',
        )}
      />

      {/* The chat + action-panel row — the SAME one `SessionChat` renders, so the
          conversation column is the same width on both sides of the crossfade
          and the panel chevron is already on screen when the real chat takes
          over. It used to be missing here entirely: the chat gained a 40px
          in-flow column the shell did not have, and every centered thing in the
          body — thread and composer — jumped 20px left at handover. See
          session-body.tsx.

          Gated on `submitted` because the pre-submit surface is the project-home
          empty state, which must stay centered on the full width exactly as
          project home draws it. Nothing crossfades out of that state; the thread
          below is what `SessionChat` replaces. */}
      <SessionBodyRow actionPanel={!!submitted} transient>
        {/* Empty new session → the identical project-home empty state (centered
            heading + hero composer + starter chips, setup pills at the bottom),
            so a fresh session opens onto the same surface as the project index
            page. Swapped out for the optimistic turn the moment a first message
            is sent (the crossfade is unchanged); the composer moves to its
            regular bottom position at the same time. */}
        {!submitted && (
          <div className="flex min-h-0 flex-1 flex-col px-4.5">
            <ProjectHomeWelcomeBody
              projectId={projectId}
              onPickSuggestion={applySuggestion}
              composer={composerEl}
            />
          </div>
        )}
        {/* Two nested boxes, the same pair `SessionChat` uses: an outer
            `min-h-0 flex-1` that yields height to the docked composer beside it,
            and the scroller itself at `h-full` inside it. Collapsing the two
            (the shell's old shape, when the composer was not a sibling) makes
            `h-full` resolve against the whole column and pushes the composer out
            of the clipped row. */}
        <div className={cn('relative z-10 min-h-0 flex-1', !submitted && 'hidden')}>
          <div className="scrollbar-hide relative z-10 h-full flex-1 overflow-y-auto">
            {/* One class, imported — not "copied verbatim" as the comment here
                used to claim. It had stopped being true: this column ran
                `px-3 py-6 sm:px-6` against the chat's `px-7 pt-6`. */}
            <div className={SESSION_TRANSCRIPT_CLASS}>
              {effectiveSubmission && !hasTranscript && (
                <div
                  className="flex min-w-0 flex-col"
                  data-queue-tone={firstPromptRow?.state === 'failed' ? 'failed' : 'pending'}
                >
                  {/* The composer shows Stop from this send on, so the one
                      Thinking row sits here, above any queued bubbles. A failed
                      delivery shows its cause instead. */}
                  <OptimisticTurn
                    text={buildOptimisticPromptTextWithUploads(
                      effectiveSubmission.text,
                      effectiveSubmission.files,
                    )}
                    attachments={effectiveSubmission.attachments}
                    uploadStatus={effectiveSubmission.uploadStatus}
                    agentNames={agentNames}
                    onFileClick={openFileInComputer}
                    deferPreview
                    sessionId={sessionId}
                    busy={firstPromptRow?.state !== 'failed'}
                    leadingStatus={
                      firstPromptRow?.state === 'failed' ? (
                        <QueuedPromptFailure
                          lastError={firstPromptRow.last_error}
                          onRetry={() => {
                            void promptInbox.retry(firstPromptRow.prompt_id)
                              .catch((error) => errorToast(error.message));
                          }}
                        />
                      ) : undefined
                    }
                  />
                </div>
              )}
              {!hasTranscript &&
                transcriptQueue.map((entry) => (
                  <div
                    key={entry.id}
                    data-pending-prompt-id={entry.id}
                    data-queue-tone={entry.prompt?.state === 'failed' ? 'failed' : 'pending'}
                    className="mt-12"
                  >
                    <OptimisticTurn
                      text={entry.text}
                      attachments={entry.attachments}
                      agentNames={agentNames}
                      deferPreview
                      busy={false}
                      className={QUEUED_BUBBLE_OPACITY_CLASS}
                      leadingStatus={
                        entry.prompt?.state === 'failed' ? (
                          <QueuedPromptFailure
                            lastError={entry.prompt.last_error}
                            onRetry={() => {
                              void promptInbox
                                .retry(entry.prompt!.prompt_id)
                                .catch((error) => errorToast(error.message));
                            }}
                            onRemove={() => {
                              void promptInbox
                                .remove(entry.prompt!.prompt_id)
                                .catch((error) => errorToast(error.message));
                            }}
                          />
                        ) : undefined
                      }
                    />
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* Once a first message is sent the composer leaves the hero position and
            docks at the bottom for the thread view (the same jump Perplexity
            makes when a search becomes a thread). INSIDE the body column, where
            `SessionChat` docks its own: outside it, it centered against the full
            width while the chat's centered against width-minus-panel. */}
        {submitted ? composerEl : null}
      </SessionBodyRow>
    </div>
  );

  return (
    <SessionLayout
      sessionId={sessionId}
      projectId={projectId}
      projectSessionId={sessionId}
      transient
      // Side-panel content: the boot checklist while still coming up, then the
      // real (empty) Actions view once ready — so an open panel is never stuck on
      // "Connecting". Visibility stays user-controlled (no auto-open).
      bootStage={ready ? null : stage}
    >
      {column}
    </SessionLayout>
  );
}

/**
 * Portals the welcome wallpaper into SessionLayout's full-bleed layer (exactly
 * like SessionChat) so it spans the entire session width and never re-crops when
 * the side panel opens. Falls back to inline on mobile (no layer). Must render
 * as a descendant of SessionLayout to read the layer from context.
 */
const shellWallpaperEl = (
  <div className="pointer-events-none absolute inset-0 z-0">
    <SessionWelcome />
  </div>
);

function ShellWallpaper() {
  const layer = useSessionWallpaperLayer();
  return layer ? createPortal(shellWallpaperEl, layer) : shellWallpaperEl;
}
