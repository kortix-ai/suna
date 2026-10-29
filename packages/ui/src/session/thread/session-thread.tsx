'use client';

/**
 * The whole session thread, from one `useSession` result:
 *
 *   const session = useSession(projectId, sessionId);
 *   return <SessionThread session={session} />;
 *
 * It is the same `SessionChat` apps/web renders: the transcript, tool rows,
 * prompts, the composer and its pickers. The parent sets the height; the
 * thread fills it. Every tool renderer is registered on import.
 *
 * Alone, it has no side panel: its "open in the panel" actions (Preview, file
 * chips, Terminal, Browser) open an overlay (`SessionPanelFallback`). Inside
 * `SessionWorkspace` they open in the side panel.
 *
 * A host that just created the session passes `firstPrompt`: the prompt shows
 * at once, as the turn the transcript will draw, while the computer boots.
 */

import type { UseSessionResult } from '@kortix/sdk/react';
import { useContext, useEffect } from 'react';

import { cn } from '../../lib/utils';
import { ProjectScope } from '../../internal/project-scope';
import { useFirstPromptPreviewStore } from '../composer/stores/session-composer-handoff-store';
import { ProviderPoolDraftBoundary } from '../overrides/provider-pool-draft-context';
import { SessionPanelFallback } from '../panel/panel-fallback';
import { SessionChat } from './session-chat';
import { SessionStartingLoader } from '../status/session-starting-loader';
import { OptimisticTurn } from './optimistic-turn';
import { SESSION_TRANSCRIPT_CLASS } from './session-transcript-class';
import { ThreadBootRows } from './thread-boot-rows';
import { TranscriptRowsContext } from './transcript-rows';
import '../tool/tools/register';

export interface SessionThreadProps {
  /** The result of `useSession(projectId, sessionId)` from `@kortix/sdk/react`. */
  session: UseSessionResult;
  /** Hide the thread's own header (title, share, context menu). */
  hideHeader?: boolean;
  /** Hide the composer: a transcript to read, not to answer. */
  readOnly?: boolean;
  /** The reply composer's placeholder. Default: the composer's own. */
  composerPlaceholder?: string;
  /**
   * A quote the host adds to the composer's reply quotes (the card above the
   * input), as a transcript selection's "Reply" does. Each new `id` adds its
   * `text` once.
   */
  quote?: { id: number; text: string } | null;
  /**
   * The first prompt of a session this host just created, as sent. Drawn at
   * once (the prompt and the agent's Thinking row) while the computer boots,
   * then handed to the transcript without a jump. Pass it only for that
   * fresh session: the transcript draws its prompts from then on.
   */
  firstPrompt?: string;
  /** `compact`: tighter gutters for a narrow column (a side sheet). Default: the session page's. */
  density?: 'default' | 'compact';
  className?: string;
}

export function SessionThread({
  session,
  hideHeader = false,
  readOnly = false,
  composerPlaceholder,
  quote,
  firstPrompt,
  density = 'default',
  className,
}: SessionThreadProps) {
  const { projectId, sessionId, runtimeSessionId } = session;
  const rows = useContext(TranscriptRowsContext) !== null;
  // The same stand-in the instant session shell hands `SessionChat`: it draws
  // the prompt until its transcript has it, then forgets it.
  const bootPrompt = useFirstPromptPreviewStore((state) => state.previewBySession[sessionId]?.text ?? null) ?? (firstPrompt?.trim() || null);
  useEffect(() => {
    if (firstPrompt?.trim()) useFirstPromptPreviewStore.getState().setFirstPromptPreview(sessionId, firstPrompt, []);
  }, [sessionId, firstPrompt]);
  return (
    <ProjectScope projectId={projectId} sessionId={sessionId}>
      <ProviderPoolDraftBoundary identity={`${projectId}/${sessionId}`}>
        <div
          data-slot="session-thread"
          data-density={density}
          className={cn('group/thread relative flex h-full min-h-0 flex-col', className)}
        >
          {runtimeSessionId ? (
            <SessionChat
              key={runtimeSessionId}
              sessionId={runtimeSessionId}
              projectSessionId={sessionId}
              projectId={projectId}
              sessionState={session}
              hideHeader={hideHeader}
              readOnly={readOnly}
              composerPlaceholder={composerPlaceholder}
              hostQuote={quote}
            />
          ) : rows ? (
            // A channel thread: its prompt, the agent's busy row and the reply
            // box from the first frame, while the computer comes up.
            <ThreadBootRows
              projectId={projectId}
              sessionId={sessionId}
              composerPlaceholder={composerPlaceholder}
              readOnly={readOnly}
            />
          ) : bootPrompt ? (
            <>
              <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto">
                <div className={SESSION_TRANSCRIPT_CLASS}>
                  <OptimisticTurn text={bootPrompt} deferPreview sessionId={sessionId} />
                </div>
              </div>
              {/* A wake that needs attention (a retry note, a stuck restart) speaks under the prompt. */}
              <div className="shrink-0">
                <SessionStartingLoader projectId={projectId} sessionId={sessionId} />
              </div>
            </>
          ) : (
            <SessionStartingLoader
              projectId={projectId}
              sessionId={sessionId}
            />
          )}
          <SessionPanelFallback
            projectId={projectId}
            projectSessionId={sessionId}
            runtimeSessionId={runtimeSessionId}
          />
        </div>
      </ProviderPoolDraftBoundary>
    </ProjectScope>
  );
}
