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
import {
  attachedFilesToDataUrlParts,
  buildOptimisticPromptTextWithUploads,
} from '@/features/session/uploaded-file-refs';
import { ProjectHomeWelcomeBody } from '@/features/workspace/project-layout/project-home';
import type { Command } from '@kortix/sdk/react';
import {
  readStartStash,
  startSessionWithPrompt,
  useRuntimeAgents,
  useSessionPrompts,
  writeStartStash,
} from '@kortix/sdk/react';
import { errorToast } from '@/components/ui/toast';
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { usePendingFilesStore } from '@/stores/session-composer-handoff-store';
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
  const effectiveSubmission = submission ?? pendingRowSubmission ?? stashedSubmission;
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
