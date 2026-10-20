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
 */

import type { UseSessionResult } from '@kortix/sdk/react';

import { cn } from '../../lib/utils';
import { ProjectScope } from '../../internal/project-scope';
import { ProviderPoolDraftBoundary } from '../overrides/provider-pool-draft-context';
import { SessionPanelFallback } from '../panel/panel-fallback';
import { SessionChat } from './session-chat';
import { SessionStartingLoader } from '../status/session-starting-loader';
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
  className?: string;
}

export function SessionThread({
  session,
  hideHeader = false,
  readOnly = false,
  composerPlaceholder,
  className,
}: SessionThreadProps) {
  const { projectId, sessionId, runtimeSessionId } = session;
  return (
    <ProjectScope projectId={projectId} sessionId={sessionId}>
      <ProviderPoolDraftBoundary identity={`${projectId}/${sessionId}`}>
        <div data-slot="session-thread" className={cn('relative flex h-full min-h-0 flex-col', className)}>
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
            />
          ) : (
            <SessionStartingLoader
              stage={session.stage === 'starting' ? 'starting' : 'provisioning'}
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
