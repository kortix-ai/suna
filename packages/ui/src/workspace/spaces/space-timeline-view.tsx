'use client';

import type { ProjectSession, ProjectSpace } from '@kortix/sdk';
import { useProjectSessions } from '@kortix/sdk/react';
import { ChatTeardropTextIcon, RobotIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import { UserAvatar } from '../../primitives/user-avatar';
import { sessionDisplayLabel, sessionDisplayStatus } from '../../session/actions/session-label';
import { SessionStatusMark } from '../sidebar/session-status-mark';
import {
  agentLabel,
  buildSpaceTimeline,
  dayKind,
  lastReplyLabel,
  threadIsWorking,
  threadMessageText,
  type TimelineDay,
} from './space-timeline';

/**
 * The space's threads: top-level sessions only (`parent: 'root'`, a child
 * thread is part of its parent). Polls page one every 5 s while an agent works
 * so the "is working" line settles, else every 15 s so a member's new thread
 * shows up. Active threads sort first, so page one holds them; older pages the
 * viewer loaded are not re-read on each tick.
 */
export function useSpaceThreads(projectId: string, spaceId: string | undefined) {
  return useProjectSessions(projectId, {
    spaceId,
    parent: 'root',
    enabled: !!spaceId,
    refetchInterval: (sessions) => (sessions.some(threadIsWorking) ? 5_000 : 15_000),
    pollFirstPageOnly: true,
  });
}

type SpaceThreads = ReturnType<typeof useSpaceThreads>;

function ThreadsLoadError({ threads }: { threads: SpaceThreads }) {
  const t = useTranslations('spaces.view');
  return (
    <ErrorState
      size="sm"
      title={t('threadsLoadError')}
      action={
        <Button variant="outline" size="sm" onClick={() => threads.refetch()}>
          {t('retry')}
        </Button>
      }
    />
  );
}

/**
 * The Chat tab: the welcome block, then one row per thread, oldest at the top,
 * grouped under day dividers. The column is reversed, so it opens scrolled to
 * the newest thread and stays there as threads arrive.
 */
export function SpaceTimeline({
  space,
  threads,
  selectedId,
  onOpenThread,
}: {
  space: ProjectSpace;
  threads: SpaceThreads;
  selectedId: string | null;
  onOpenThread: (sessionId: string) => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const days = useMemo(() => buildSpaceTimeline(threads.sessions), [threads.sessions]);
  const loading = threads.isLoading || threads.isScanning;
  const now = new Date();

  const dayLabel = (day: TimelineDay) => {
    const kind = dayKind(day.date, now);
    if (kind === 'today') return t('today');
    if (kind === 'yesterday') return t('yesterday');
    return day.date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <div className="pb-2">
        {threads.isError && !threads.data ? (
          <div className="px-5 py-8">
            <ThreadsLoadError threads={threads} />
          </div>
        ) : loading ? null : (
          <>
            {threads.hasNextPage ? (
              <div className="flex justify-center px-5 pt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => threads.fetchNextPage()}
                  disabled={threads.isFetchingNextPage}
                  aria-busy={threads.isFetchingNextPage || undefined}
                >
                  {t('loadEarlier')}
                </Button>
              </div>
            ) : (
              <SpaceWelcome space={space} empty={days.length === 0} />
            )}
            {days.map((day) => (
              <section key={day.date.getTime()} aria-label={dayLabel(day)}>
                <DayDivider label={dayLabel(day)} />
                {day.threads.map(({ session, compact }) => (
                  <ThreadRow
                    key={session.session_id}
                    session={session}
                    compact={compact}
                    space={space}
                    selected={session.session_id === selectedId}
                    onOpen={() => onOpenThread(session.session_id)}
                  />
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** The top of the history: "Welcome to #name" for a channel, the DM's agent for a DM. */
function SpaceWelcome({ space, empty }: { space: ProjectSpace; empty: boolean }) {
  const t = useTranslations('spaces.view');
  if (space.kind === 'dm' && space.dm_agent_name) {
    const agent = agentLabel(space.dm_agent_name);
    return (
      <div className="space-y-3 px-5 pt-10 pb-4">
        <EntityAvatar icon={RobotIcon} label={agent} size="lg" />
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{agent}</h2>
          <p className="text-muted-foreground text-sm text-pretty">{t('dmIntro', { agent })}</p>
        </div>
      </div>
    );
  }
  const name = space.slug ?? space.name;
  return (
    <div className="space-y-1.5 px-5 pt-10 pb-4">
      <h2 className="text-2xl font-semibold tracking-tight text-balance">{t('welcomeTitle', { name })}</h2>
      <p className="text-muted-foreground text-sm text-pretty">
        {space.description || t(empty ? 'welcomeEmpty' : 'welcomeStart', { name })}
      </p>
    </div>
  );
}

/** A centred pill on a hairline: "Today", "Yesterday", "Thursday, October 15". */
function DayDivider({ label }: { label: string }) {
  return (
    <div className="relative flex items-center justify-center px-5 py-2" aria-hidden>
      <div className="bg-border absolute inset-x-0 top-1/2 h-px" />
      <span className="bg-background relative rounded-full border px-3 py-0.5 text-xs font-medium">{label}</span>
    </div>
  );
}

/**
 * One thread as a message: the author's avatar and name, the time, the first
 * prompt, and the line that opens the thread. A thread from the same author
 * within 5 minutes drops the avatar and name; its time shows in the gutter on
 * hover.
 */
function ThreadRow({
  session,
  compact,
  space,
  selected,
  onOpen,
}: {
  session: ProjectSession;
  compact: boolean;
  space: ProjectSpace;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const created = new Date(session.created_at);
  const time = created.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const author = session.owner_name || session.owner_email || t('authorFallback');
  const agentName = session.agent_name ?? space.dm_agent_name;
  const agent = agentName ? agentLabel(agentName) : t('agentFallback');
  const working = threadIsWorking(session);

  return (
    <div
      className={cn(
        'group/row hover:bg-hover duration-fast relative flex gap-2 px-5 transition-colors',
        compact ? 'py-0.5' : 'pt-2 pb-1',
        selected && 'bg-active',
      )}
    >
      <div className="w-10 shrink-0">
        {compact ? (
          <time
            dateTime={session.created_at}
            className="text-muted-foreground invisible block pt-0.5 text-right text-xs whitespace-nowrap tabular-nums group-focus-within/row:visible group-hover/row:visible"
          >
            {time}
          </time>
        ) : (
          <UserAvatar
            email={session.owner_email ?? ''}
            name={author}
            avatarUrl={session.owner_avatar_url}
            size="lg"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {compact ? null : (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{author}</span>
            <time
              dateTime={session.created_at}
              title={created.toLocaleString(locale)}
              className="text-muted-foreground shrink-0 text-xs tabular-nums"
            >
              {time}
            </time>
          </div>
        )}
        <p className="text-sm text-pretty whitespace-pre-wrap wrap-anywhere">{threadMessageText(session)}</p>
        <button
          type="button"
          onClick={onOpen}
          className="group/summary hover:bg-background hover:border-border focus-visible:ring-ring duration-fast -mx-1 mt-1 flex max-w-full items-center gap-2 rounded-md border border-transparent px-1 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2"
        >
          <EntityAvatar icon={RobotIcon} label={agent} size="xs" />
          {/* Ink, underlined on hover: the inline-link recipe. An accent fails AA as text. */}
          <span className="text-foreground shrink-0 font-medium tabular-nums underline-offset-4 group-hover/summary:underline">
            {session.reply_count ? t('replies', { count: session.reply_count }) : t('openThread')}
          </span>
          {working ? (
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
              <SessionDotMatrix sessionId={session.session_id} size={14} className="shrink-0" />
              <span className="truncate">{t('working', { agent })}</span>
            </span>
          ) : (
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
              <SessionStatusMark status={sessionDisplayStatus(session)} />
              <span className="truncate">{t('lastReply', { time: lastReplyLabel(session, locale) })}</span>
            </span>
          )}
        </button>
      </div>
      <div className="bg-popover absolute -top-3 right-5 hidden rounded-md border shadow-md group-focus-within/row:flex group-hover/row:flex">
        <Hint label={t('replyInThread')} side="top">
          <Button variant="ghost" size="icon-sm" aria-label={t('replyInThread')} onClick={onOpen}>
            <ChatTeardropTextIcon className="size-4" />
          </Button>
        </Hint>
      </div>
    </div>
  );
}

/** The Threads tab: every thread, last activity first. */
export function SpaceThreadList({
  threads,
  selectedId,
  onOpenThread,
}: {
  threads: SpaceThreads;
  selectedId: string | null;
  onOpenThread: (sessionId: string) => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const sorted = useMemo(
    () => [...threads.sessions].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [threads.sessions],
  );

  if (threads.isError && !threads.data) {
    return (
      <div className="px-5 py-8">
        <ThreadsLoadError threads={threads} />
      </div>
    );
  }
  if (threads.isLoading || threads.isScanning) return null;
  if (sorted.length === 0) {
    return (
      <div className="px-5 py-8">
        <EmptyState size="sm" title={t('threadsEmpty')} />
      </div>
    );
  }
  return (
    <div className="py-2">
      <ul>
        {sorted.map((session) => (
          <li key={session.session_id}>
            <button
              type="button"
              onClick={() => onOpenThread(session.session_id)}
              className={cn(
                'hover:bg-hover duration-fast flex w-full items-center gap-3 px-5 py-2 text-left transition-colors',
                session.session_id === selectedId && 'bg-active',
              )}
            >
              <SessionStatusMark status={sessionDisplayStatus(session)} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{sessionDisplayLabel(session)}</span>
              <time
                dateTime={session.updated_at}
                className="text-muted-foreground shrink-0 text-xs tabular-nums"
              >
                {relativeTime(session.updated_at, locale)}
              </time>
            </button>
          </li>
        ))}
      </ul>
      {threads.hasNextPage ? (
        <div className="flex justify-center px-5 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => threads.fetchNextPage()}
            disabled={threads.isFetchingNextPage}
            aria-busy={threads.isFetchingNextPage || undefined}
          >
            {t('loadEarlier')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
