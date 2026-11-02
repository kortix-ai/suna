'use client';

import { sessionLogTurns, type SessionLogTurn } from '@kortix/sdk';
import { useSessionView } from '@kortix/sdk/react';
import { ChatsCircleIcon } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { useTranslations } from '../../i18n';
import { ProjectScope } from '../../internal/project-scope';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import Loading from '../../primitives/loading';
import { Skeleton } from '../../primitives/skeleton';
import { SessionTurn } from '../thread/transcript';
import { SESSION_TRANSCRIPT_CLASS } from '../thread/session-transcript-class';
import '../tool/tools/register';

/** The live thread is read at most once per this window while a turn streams. */
const PEEK_THROTTLE_MS = 100;
const NO_REQUESTS: never[] = [];
const noop = () => {};
const noopAsync = async () => {};
/** A view rewinds nothing: every turn's history control stays off. */
const TURN_OUTCOME = {};

/**
 * The transcript of another session, read-only, from the API alone
 * (`useSessionView`): its log and its stream. It never starts the session and
 * never points the app's runtime at the session's box, so it can sit beside
 * the session page that owns the runtime: a sub-agent's dialog over its lead's
 * chat, the board's preview. Never blank: a skeleton while the log loads, an
 * error with "Try again", "Nothing yet" for a session with no message.
 */
export function SessionPeek({
  projectId,
  sessionId,
  working = false,
  onActivity,
  density = 'default',
  className,
}: {
  projectId: string;
  sessionId: string;
  /** The session works now: its last turn shows the agent's busy row. */
  working?: boolean;
  /** Called when a message arrives or changes count: the host re-reads the session's state. */
  onActivity?: () => void;
  /** `compact`: the narrow gutters of a side sheet, as `SessionThread`'s density. */
  density?: 'default' | 'compact';
  className?: string;
}) {
  const t = useTranslations('multiAgent.subagent');
  const view = useSessionView(projectId, sessionId, { throttleMs: PEEK_THROTTLE_MS });
  const turns = useMemo<SessionLogTurn[]>(
    () => (view.thread ? sessionLogTurns(view.thread, { foldCompactions: true, busy: working }) : []),
    [view.thread, working],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Open at the newest message, and follow new ones while the reader sits at the bottom.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [turns]);
  useEffect(() => {
    pinned.current = true;
  }, [sessionId]);
  const count = view.thread?.messages.length ?? 0;
  const activity = useRef(onActivity);
  useEffect(() => {
    activity.current = onActivity;
  });
  useEffect(() => {
    if (count > 0) activity.current?.();
  }, [count]);

  return (
    <div
      data-testid="session-peek"
      data-status={view.status}
      data-density={density}
      className={cn('group/thread flex min-h-0 flex-1 flex-col', className)}
    >
      {view.status === 'loading' ? (
        <div className={cn(SESSION_TRANSCRIPT_CLASS, 'space-y-4')} aria-busy="true">
          <Skeleton className="ml-auto h-9 w-2/5 rounded-xl" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : view.status === 'error' ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <ErrorState
            size="sm"
            title={t('loadFailed')}
            action={
              <Button variant="outline" size="sm" onClick={view.retry}>
                {t('retry')}
              </Button>
            }
          />
        </div>
      ) : view.status === 'empty' ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState size="sm" icon={ChatsCircleIcon} title={t('emptyTitle')} description={t('emptyDescription')} />
        </div>
      ) : (
        <ProjectScope projectId={projectId} sessionId={sessionId}>
          <div
            ref={scrollRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className={cn(SESSION_TRANSCRIPT_CLASS, 'pb-6')}>
              {view.hasOlder && (
                <div className="mb-4 flex justify-center">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={view.isLoadingOlder}
                    onClick={() => {
                      pinned.current = false;
                      void view.loadOlder();
                    }}
                    className="text-muted-foreground"
                  >
                    {view.isLoadingOlder && <Loading className="size-3 shrink-0" />}
                    {t('loadOlder')}
                  </Button>
                </div>
              )}
              <div className="space-y-6">
                {turns.map((turn, index) => {
                  const last = index === turns.length - 1;
                  return (
                    <SessionTurn
                      key={turn.id}
                      turn={turn}
                      turnOutcome={TURN_OUTCOME}
                      sessionId={view.thread?.thread_id ?? sessionId}
                      sessionStatus={undefined}
                      isLast={last}
                      ownsPlan={false}
                      permissions={NO_REQUESTS}
                      questions={NO_REQUESTS}
                      isFirstTurn={index === 0}
                      sessionWorking={working}
                      isWorkingTurn={last && working}
                      suppressBusyIndicator={false}
                      awaitingUser={false}
                      pending={false}
                      disableToolNavigation
                      onPermissionReply={noopAsync}
                      onRewind={noop}
                      rewindDisabled
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </ProjectScope>
      )}
    </div>
  );
}
