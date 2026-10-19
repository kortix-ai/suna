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
 */

import type { UseSessionResult } from '@kortix/sdk/react';

import { cn } from '../../lib/utils';
import { SessionIdsProvider } from '../../providers/session-ids';
import { ProviderPoolDraftBoundary } from '../overrides/provider-pool-draft-context';
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
  className?: string;
}

export function SessionThread({ session, hideHeader = false, readOnly = false, className }: SessionThreadProps) {
  const { projectId, sessionId, runtimeSessionId } = session;
  return (
    <SessionIdsProvider projectId={projectId} sessionId={sessionId}>
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
            />
          ) : (
            <SessionStartingLoader
              stage={session.stage === 'starting' ? 'starting' : 'provisioning'}
              projectId={projectId}
              sessionId={sessionId}
            />
          )}
        </div>
      </ProviderPoolDraftBoundary>
    </SessionIdsProvider>
  );
}
