'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { errorToast } from '@/components/ui/toast';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
import { SESSION_TRANSCRIPT_CLASS, SessionBodyRow } from '@/features/session/session-body';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SessionLayout } from '@/features/session/session-layout';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import { SessionWelcome } from '@/features/session/session-welcome';
import { QueuedPromptBubbles } from '@/features/session/turn/queued-prompt-bubbles';
import {
  attachedFilesToDataUrlParts,
  buildOptimisticPromptTextWithUploads,
} from '@/features/session/uploaded-file-refs';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  useFirstPromptPreviewStore,
  usePendingFilesStore,
} from '@/stores/session-composer-handoff-store';
import type { SessionStartStage } from '@kortix/sdk';
import type { Command } from '@kortix/sdk/react';
import {
  readStartStash,
  startSessionWithPrompt,
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
}: {
  projectId: string;
  /** The route's session id (== the pending-prompt namespace the page migrates). */
  sessionId: string;
  stage: SessionStartStage;
  /** Immutable project-session agent returned by /start. */
  boundAgentName?: string | null;
  /** Fired on the first send so the page can mount the real chat (which auto-sends
   *  the handed-off prompt) and crossfade it in. */
  onSubmit?: () => void;
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
  const [submission, setSubmission] = useState<{
    text: string;
    files: AttachedFile[];
  } | null>(null);
  // Every send AFTER the first, painted the moment Enter lands — the durable
  // row takes over on the next poll. Without this the shell drew only the
  // first prompt, and anything typed while the box booted stayed invisible
  // until the real chat mounted (measured: four prompts popping in at once,
  // ~15 s later).
  const [extraSends, setExtraSends] = useState<Array<{ id: string; text: string }>>([]);
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
  const pendingRowSubmission = useMemo(() => {
    const row = promptInbox.prompts.find((p) => p.text.trim().length > 0);
    if (!row) return null;
    return { text: row.text, files: [] as AttachedFile[] };
  }, [promptInbox.prompts]);
  // The queue behind the first prompt: every durable row after the first,
  // plus the sends this shell has made that no row lists yet (matched by
  // text, which is all the list view carries).
  const queuedBehindFirst = useMemo(() => {
    const rows = promptInbox.prompts.filter((p) => p.text.trim().length > 0);
    const behind = rows.slice(1).map((p) => ({ id: p.prompt_id, text: p.text }));
    const listed = new Set(rows.map((p) => p.text.trim()));
    for (const extra of extraSends) {
      if (!listed.has(extra.text.trim())) behind.push(extra);
    }
    return behind;
  }, [promptInbox.prompts, extraSends]);
  // The producer's own copy of the first prompt, drawn from the first frame —
  // the row read above can miss it entirely when a warm box delivers between
  // navigation and the fetch. See `useFirstPromptPreviewStore`.
  const previewSubmission = useFirstPromptPreviewStore(
    (s) => s.previewBySession[sessionId] ?? null,
  );
  const effectiveSubmission =
    submission ?? previewSubmission ?? pendingRowSubmission ?? stashedSubmission;
  const submitted = effectiveSubmission?.text ?? null;

  // Starter-prompt → composer prefill, identical to the project-home composer.
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);
  const applySuggestion = useCallback((text: string) => {
    setPrefill({ text, id: Date.now() });
  }, []);

  const handleSend = useCallback(
    async (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => {
      if (!text.trim() && !files?.length) return;
      // Hand the PICKS to the real chat through the stash (it seeds the
      // per-session model/agent stores from them). The prompt itself does not
      // travel this way any more — it becomes a durable inbox row below.
      writeStartStash(sessionId, {
        prompt: '',
        agent: options.agent ?? null,
        model: options.model ?? null,
        variant: options.variant ?? null,
      });
      // The durable row, POSTed NOW. Attachments ride as data: URLs — there is
      // no sandbox to upload into yet. A SECOND message typed while the first
      // boots POSTs the same way: the admission gate orders rows by
      // (available_at, created_at), so two rows created in order deliver in
      // order — which is exactly what the refusal that used to live here was
      // faking with a toast and a carried draft. AWAITED, and thrown on
      // failure, so the composer's own recovery puts the text and attachments
      // back in the editor instead of painting a bubble for a message the
      // server never got.
      try {
        const parts = [
          { type: 'text' as const, text },
          ...(await attachedFilesToDataUrlParts(files)),
        ];
        await startSessionWithPrompt(projectId, sessionId, {
          parts,
          overrides: {
            ...(options.agent ? { agent: options.agent } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.variant ? { variant: options.variant } : {}),
          },
        });
      } catch (error) {
        errorToast(error instanceof Error ? error.message : 'Could not queue your message');
        throw error;
      }
      playSound('send');
      if (!submitted) {
        setSubmission({ text, files: files ?? [] });
        onSubmit?.();
      } else {
        setExtraSends((prev) => [...prev, { id: `shell-extra-${Date.now()}`, text }]);
      }
    },
    [projectId, sessionId, submitted, onSubmit],
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
      sessionId={sessionId}
      projectId={projectId}
      draftScope={draftScope}
      prefill={prefill}
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
                `px-3 py-6 sm:px-6` against the chat's `px-7 pt-6 md:pr-4`. */}
            <div className={SESSION_TRANSCRIPT_CLASS}>
              {effectiveSubmission && (
                <div className="flex min-w-0 flex-col">
                  {/* The optimistic turn, rendered by the component SessionChat
                    also renders — not a copy of it. `deferPreview` is the one
                    difference the shell is entitled to: there is no sandbox yet,
                    so MessageAttachments paints every tile as pending. The
                    waiting row underneath says "Thinking" at every boot stage,
                    exactly as it will once the real chat takes over. */}
                  <OptimisticTurn
                    text={buildOptimisticPromptTextWithUploads(
                      effectiveSubmission.text,
                      effectiveSubmission.files,
                    )}
                    agentNames={agentNames}
                    onFileClick={openFileInComputer}
                    deferPreview
                    sessionId={sessionId}
                  />
                  {/* What was typed while the box boots, as the dimmed queued
                    bubbles they already are on the server — same component
                    SessionChat draws, so the crossfade changes nothing. */}
                  <QueuedPromptBubbles className="mt-3" queued={queuedBehindFirst} />
                </div>
              )}
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
