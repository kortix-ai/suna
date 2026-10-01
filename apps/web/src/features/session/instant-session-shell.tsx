'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { errorToast } from '@/components/ui/toast';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import { QueuedPromptList } from '@/features/session/composer/queued-prompt-list';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
import { isFirstPromptRow, projectQueueRows } from '@/features/session/queue-projection';
import { SESSION_TRANSCRIPT_CLASS, SessionBodyRow } from '@/features/session/session-body';
import { SessionLayout } from '@/features/session/session-layout';
import { SessionMessageCard } from '@/features/session/turn/session-message-card';
import { isAskForViewer } from '@/features/session/turn/message-author';
import { parseSessionMessagePrompt } from '@/features/session/message-parsing';
import { useAuth } from '@/features/providers/auth-provider';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import { SessionWelcome } from '@/features/session/session-welcome';
import {
  QUEUED_BUBBLE_OPACITY_CLASS,
  QueuedPromptFailure,
} from '@/features/session/turn/queued-prompt-bubbles';
import { buildOptimisticPromptTextWithUploads } from '@/features/session/uploaded-file-refs';
import { useInstantSessionSend } from '@/features/session/use-instant-session-send';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import type { SessionPromptOverrides, SessionStartStage } from '@kortix/sdk';
import type { Command } from '@kortix/sdk/react';
import {
  useFeatureFlag,
  usePromptAttachments,
  useRuntimeAgents,
  useSessionPrompts,
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
  // The durable rows are the cross-navigation truth: a send made on the
  // project home is an inbox row by the time this shell mounts, and reading it
  // from the server is what keeps the bubble on screen after a reload — the
  // stash only carries picks now. The local `submission` covers the same-page
  // send instantly; the stash read stays as a legacy fallback for a hand-off
  // written by a pre-deploy tab.
  const promptInbox = useSessionPrompts(projectId, sessionId, { enabled: hydrated });
  const firstPromptRow = promptInbox.prompts.find((p) => isFirstPromptRow(p));
  // An ask's first message (`no_reply`) goes to people: show it as the ask card,
  // with no Thinking row and no Stop button while the box boots.
  const { user: viewer } = useAuth();
  const { enabled: humanMessaging } = useFeatureFlag(projectId, 'human_messaging');
  const askInfo = humanMessaging && firstPromptRow?.no_reply
    ? parseSessionMessagePrompt(firstPromptRow.full_text ?? firstPromptRow.text)
    : undefined;
  const send = useInstantSessionSend({
    projectId,
    sessionId,
    hydrated,
    onSubmit,
    promptInbox,
  });
  const { submitted, effectiveSubmission, extraSends, handleSend } = send;
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
      isBusy={!!submitted && !askInfo}
      // The first message IS the turn as far as this shell is concerned, so a
      // `/` command submitted now is refused with the same message a command
      // typed mid-turn gets, rather than racing the boot.
      sessionWorking={!!submitted && !askInfo}
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
                  {askInfo ? (
                    <SessionMessageCard
                      info={askInfo}
                      replyHint={isAskForViewer(askInfo, viewer?.email)}
                    />
                  ) : (
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
                  )}
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
