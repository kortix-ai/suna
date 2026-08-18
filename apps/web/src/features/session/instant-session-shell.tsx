'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SessionLayout } from '@/features/session/session-layout';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import { SessionWelcome } from '@/features/session/session-welcome';
import { buildOptimisticPromptTextWithUploads } from '@/features/session/uploaded-file-refs';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import type { Command } from '@kortix/sdk/react';
import { readStartStash, useRuntimeAgents, writeStartStash } from '@kortix/sdk/react';
import { infoToast } from '@/components/ui/toast';
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useCarriedDraftStore, usePendingFilesStore } from '@/stores/session-composer-handoff-store';
import type { SessionStartStage } from '@kortix/sdk';

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
  const effectiveSubmission = submission ?? stashedSubmission;
  const submitted = effectiveSubmission?.text ?? null;

  // Starter-prompt → composer prefill, identical to the project-home composer.
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);
  const applySuggestion = useCallback((text: string) => {
    setPrefill({ text, id: Date.now() });
  }, []);

  const handleSend = useCallback(
    (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => {
      if (!text.trim() && !files?.length) return;
      // A SECOND message, typed while the first one is still booting, is
      // REFUSED — and refused by throwing, which is what keeps the draft.
      //
      // The three answers this has had, in order: `return` outright (the
      // composer had already cleared the input, so the draft was simply gone);
      // then a browser-local queue, because the FIRST message is still
      // travelling through the start stash and is not an inbox row yet, so a
      // row created now would be admitted — and answered — BEFORE it; and now
      // this. The local queue is gone with the rest of the browser queue, and
      // POSTing here would reintroduce exactly that ordering inversion.
      //
      // Throwing rather than returning is half of it: `dispatchSubmission`
      // catches it and `planFailedSendRecovery` puts the text and the
      // attachments back in the editor.
      //
      // The other half is `carryDraft`. That editor is THIS component's, and
      // this component is unmounted by the crossfade the moment the sandbox is
      // ready — so the recovered draft used to die with it, right after a toast
      // that promised it was kept. The boot it dies at the end of is 19-25 s
      // (measured), which is exactly when a follow-up gets typed. The draft is
      // handed to the session instead, and `SessionChat` picks it up when it
      // mounts. Nothing is SENT: the ordering rule above is untouched.
      if (submitted) {
        useCarriedDraftStore.getState().carryDraft(sessionId, text, files ?? []);
        infoToast('Still starting this session', {
          description: 'Your message is kept in the composer — send it again in a moment.',
        });
        throw new Error('The first message is still starting — send this one in a moment');
      }
      playSound('send');

      // Hand the message to the real chat: it auto-sends from this stash once
      // the runtime is healthy. `sessionId` here is the route/Kortix-session
      // id, not the eventual OpenCode pin (`useCanonicalRuntimeSession`
      // resolves those independently — see `ensureOpencodeSessionPin` in
      // apps/api/src/projects/routes/shared.ts); the session page's
      // `migrateStash` hands this canonical stash off onto the resolved pin
      // once it exists.
      writeStartStash(sessionId, {
        prompt: text,
        agent: options.agent ?? null,
        model: options.model ?? null,
        variant: options.variant ?? null,
      });
      // File objects can't survive sessionStorage — stash them in the store the
      // real chat consumes (same path the home composer uses).
      if (files?.length) {
        usePendingFilesStore.getState().setPendingFiles(files);
      }

      setSubmission({ text, files: files ?? [] });
      onSubmit?.();
    },
    [sessionId, submitted, onSubmit],
  );

  const handleCommand = useCallback(
    (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      // Defer slash-commands through the same handoff as a normal first message.
      handleSend(`/${cmd.name}${args ? ` ${args}` : ''}`, undefined, options);
    },
    [handleSend],
  );

  // Defined once and slotted into either the hero position (pre-submit, inside
  // the welcome body) or the regular bottom position (post-submit thread view).
  const composerEl = (
    <ComposerChatInput
      onSend={handleSend}
      onCommand={handleCommand}
      sessionId={sessionId}
      projectId={projectId}
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

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
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
        {/* Geometry is copied from SessionChat's scroll area verbatim — same
            container padding, same max width, same inner padding. It used to run
            `px-4 py-4` against the chat's `py-6`, which put the whole thread 8px
            higher here and made the crossfade land with a visible nudge. */}
        <div
          className={cn(
            'scrollbar-hide relative z-10 overflow-y-auto',
            submitted ? 'h-full flex-1' : 'hidden',
          )}
        >
          <div className="mx-auto w-full max-w-3xl min-w-0 px-3 py-6 sm:px-6">
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
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Once a first message is sent the composer leaves the hero position and
          docks at the bottom for the thread view (the same jump Perplexity makes
          when a search becomes a thread). */}
      {submitted ? composerEl : null}
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
