'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';

import { GridFileCard } from './grid-file-card';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { AssistantPendingRow } from '@/features/session/assistant-pending-row';
import {
  ProjectHomeWelcomeBody,
  StarterPromptsCarousel,
} from '@/features/workspace/project-layout/project-home';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { optimisticUploadedFileRef } from '@/features/session/uploaded-file-refs';
import { SessionLayout } from '@/features/session/session-layout';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import { SessionWelcome } from '@/features/session/session-welcome';
import type { Command } from '@/hooks/opencode/use-opencode-sessions';
import type { SessionStartStage } from '@kortix/sdk/projects-client';
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { usePendingFilesStore } from '@/stores/pending-files-store';

/** The inline status shown under the Kortix logo while the computer is still
 *  coming up after a first send — sleek + minimal, reflecting the live stage. */
function bootLabel(stage: SessionStartStage): string {
  if (stage === 'provisioning') return 'Provisioning your computer';
  if (stage === 'ready') return 'Connecting';
  return 'Starting your computer';
}

/**
 * The instant session shell — shown the moment a freshly-created session opens,
 * BEFORE the sandbox/runtime is ready, in place of the old full-screen loader.
 *
 * A faithful, fully-interactive empty session: welcome wallpaper + a live chat
 * input you can type into immediately (the input needs no runtime — the home
 * composer proves it). Provisioning runs silently in the background.
 *
 * On the FIRST send we stash the message on the `project_pending_*` keys (which
 * the session page migrates onto the OpenCode pin) so the real {@link SessionChat}
 * auto-sends it the instant the runtime is healthy — and the thread shows an
 * inline "starting your computer" status under the assistant logo until the real
 * chat crossfades in. The boot checklist also lives in the side panel, but only
 * if the user opens it (never auto-opened); once the runtime is ready the panel
 * gracefully falls back to the real (empty) Actions view.
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
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  // `ready` is the backend's authoritative "runtime is up" signal (POST /start).
  // Once ready, we drop boot mode so nothing is stuck on "Connecting" — even with
  // no message sent.
  const ready = stage === 'ready';

  // A pending prompt may already be staged (home composer send) → show the
  // booting view immediately in that case.
  const [submission, setSubmission] = useState<{
    text: string;
    files: AttachedFile[];
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    const text =
      sessionStorage.getItem(`opencode_pending_prompt:${sessionId}`) ??
      sessionStorage.getItem(`project_pending_prompt:${sessionId}`);
    if (!text) return null;
    return {
      text,
      files: usePendingFilesStore.getState().files,
    };
  });
  const submitted = submission?.text ?? null;

  // Starter-prompt → composer prefill, identical to the project-home composer.
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);
  const applySuggestion = useCallback((text: string) => {
    setPrefill({ text, id: Date.now() });
  }, []);

  const handleSend = useCallback(
    (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => {
      if ((!text.trim() && !files?.length) || submitted) return;
      playSound('send');

      // Hand the message to the real chat: it auto-sends from these keys once the
      // runtime is healthy (the session page migrates project_* → opencode_*).
      sessionStorage.setItem(`project_pending_prompt:${sessionId}`, text);
      if (Object.keys(options).length > 0) {
        sessionStorage.setItem(`project_pending_options:${sessionId}`, JSON.stringify(options));
      }
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
        isSidePanelOpen={isSidePanelOpen}
        onToggleSidePanel={() => {
          const s = useKortixComputerStore.getState();
          s.setActiveSession(sessionId);
          if (s.isSidePanelOpen) s.closeSidePanel();
          else s.openSidePanel();
        }}
      />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {/* Empty new session → the identical project-home empty state (welcome
            heading + setup tiles), so a fresh session opens onto the same
            surface as the project index page. Swapped out for the optimistic
            turn the moment a first message is sent (the crossfade is unchanged). */}
        {!submitted && (
          <div className="flex min-h-0 flex-1 flex-col px-4.5">
            <ProjectHomeWelcomeBody projectId={projectId} />
          </div>
        )}
        <div
          className={cn(
            'scrollbar-hide relative z-10 overflow-y-auto px-4 py-4',
            submitted ? 'h-full flex-1' : 'hidden',
          )}
        >
          <div className="mx-auto w-full max-w-3xl min-w-0 px-3 sm:px-6">
            {submission && (
              <div className="flex min-w-0 flex-col">
                {/* Optimistic turn — the EXACT same DOM shape + spacing as
                    SessionChat's optimistic block (turn wrapper → justify-end
                    bubble → pending row) so the bubble + Kortix logo never shift
                    across the shell → chat crossfade. */}
                <div className="mt-12 first:mt-0">
                  <div className="flex justify-end">
                    <div className="bg-card flex max-w-[90%] flex-col overflow-hidden rounded-3xl rounded-br-lg border">
                      {submission.files.length > 0 && (
                        <div className="flex flex-wrap gap-2 p-3 pb-0">
                          {submission.files.map((file, i) => {
                            const ref = optimisticUploadedFileRef(file);
                            return (
                              <div key={`${ref.path}-${i}`} onClick={(e) => e.stopPropagation()}>
                                <GridFileCard
                                  filePath={ref.path}
                                  fileName={ref.path.split('/').pop() || ref.path}
                                  deferPreview
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <p className="px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                        {submission.text}
                      </p>
                    </div>
                  </div>
                  {/* While the computer is still coming up the status reflects the
                      boot stage ("Starting your computer"); once ready it's the
                      regular thinking text. */}
                  <AssistantPendingRow
                    className="mt-6"
                    status={
                      ready ? undefined : (
                        <AnimatedThinkingText statusText={bootLabel(stage)} className="text-xs" />
                      )
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {!submitted && (
        <div className="relative z-10 mx-auto mb-4 w-full max-w-[52rem] px-2 sm:px-4">
          <StarterPromptsCarousel onPick={applySuggestion} />
        </div>
      )}

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
        // chat's live stop takes over the instant it crossfades in. (A duplicate
        // send is harmless — handleSend ignores it while `submitted` is set.)
        isBusy={!!submitted}
        stopDisabled={!!submitted}
        autoFocus
      />
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
function ShellWallpaper() {
  const layer = useSessionWallpaperLayer();
  const wallpaper = (
    <div className="pointer-events-none absolute inset-0 z-0">
      <SessionWelcome />
    </div>
  );
  return layer ? createPortal(wallpaper, layer) : wallpaper;
}
