'use client';

import type { ProjectSession, ProjectSpace } from '@kortix/sdk';
import { useProjectSessions } from '@kortix/sdk/react';
import {
  CaretRightIcon,
  ChatTeardropTextIcon,
  type Icon,
  LightningIcon,
  LinkSimpleIcon,
  PulseIcon,
  TimerIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import { useMemo } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { useCopy } from '../../internal/hooks/use-copy';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { UserAvatar } from '../../primitives/user-avatar';
import { sessionDisplayLabel, sessionDisplayStatus } from '../../session/actions/session-label';
import { participantLabel } from '../../session/participants/session-participants';
import { MESSAGE_TEXT_CLASS, MessageRow } from '../../session/turn/message-row';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { RememberThisButton } from '../memory/remember-this';
import { SessionStatusMark } from '../sidebar/session-status-mark';
import {
  agentLabel,
  buildSpaceTimeline,
  DEFAULT_AGENT_SLUG,
  dayKind,
  gutterTime,
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

export type SpaceThreads = ReturnType<typeof useSpaceThreads>;

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

/** "Load earlier threads", at the top of either list while older pages exist. */
function LoadEarlier({ threads }: { threads: SpaceThreads }) {
  const t = useTranslations('spaces.view');
  return (
    <div className="flex justify-center px-5 py-2">
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
      <div className="pt-4 pb-3">
        {threads.isError && !threads.data ? (
          <div className="px-5 py-8">
            <ThreadsLoadError threads={threads} />
          </div>
        ) : loading ? null : (
          <>
            {threads.hasNextPage ? (
              <LoadEarlier threads={threads} />
            ) : (
              <SpaceWelcome space={space} empty={days.length === 0} />
            )}
            {days.map((day) => (
              <section key={day.date.getTime()} aria-label={dayLabel(day)}>
                <DayDivider label={dayLabel(day)} />
                {day.threads.map((session) => (
                  <ThreadRow
                    key={session.session_id}
                    session={session}
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
      <div className="space-y-3 px-5 pt-16 pb-6">
        <AgentMark slug={space.dm_agent_name} size={42} label={agent} />
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{agent}</h2>
          <p className="text-muted-foreground text-sm text-pretty">{t('dmIntro', { agent })}</p>
        </div>
      </div>
    );
  }
  const name = space.slug ?? space.name;
  return (
    <div className="space-y-1.5 px-5 pt-16 pb-6">
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
    <div className="relative flex items-center justify-center py-2" aria-hidden>
      <div className="bg-border absolute inset-x-0 top-1/2 h-px" />
      <span className="bg-background text-foreground relative rounded-full border px-3 py-0.5 text-xs font-medium">
        {label}
      </span>
    </div>
  );
}

/** The trigger form's glyph per trigger type: a schedule, a webhook, an app event, a monitor. */
const TRIGGER_TYPE_ICONS: Record<string, Icon> = {
  cron: TimerIcon,
  webhook: WebhooksLogoIcon,
  event: LightningIcon,
  monitor: PulseIcon,
};

/**
 * A thread a trigger started: the trigger's name (stamped at fire time, else
 * its slug) and the glyph of its type. Null for any other thread.
 */
function triggerAuthor(session: ProjectSession): { name: string; icon: Icon } | null {
  if (session.initiator?.type !== 'trigger') return null;
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.trigger_name === 'string' && meta.trigger_name ? meta.trigger_name : session.initiator.label;
  if (!name) return null;
  const type = typeof meta.trigger_type === 'string' ? meta.trigger_type : '';
  return { name, icon: TRIGGER_TYPE_ICONS[type] ?? LightningIcon };
}

/**
 * One thread as a message: the author's avatar and name, the time, the first
 * prompt, and the "N replies" line that opens the thread. Every thread shows
 * its author: a new thread is a new top-level message.
 */
function ThreadRow({
  session,
  space,
  selected,
  onOpen,
}: {
  session: ProjectSession;
  space: ProjectSpace;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const created = new Date(session.created_at);
  // A trigger's run reads as the trigger: its name and its type's glyph.
  const trigger = triggerAuthor(session);
  // A trigger or an API key starts a thread as a service account: an agent tile, not a person.
  const machine = trigger !== null || session.owner_type === 'service_account';
  // The profile name, never a raw email (`participantLabel`).
  const name = trigger
    ? trigger.name
    : machine
      ? agentLabel(session.owner_name || t('agentFallback'))
      : participantLabel({ name: session.owner_name ?? null, email: session.owner_email ?? null }) ||
        t('authorFallback');

  return (
    <MessageRow
      selected={selected}
      avatar={
        machine ? (
          trigger ? (
            <EntityAvatar icon={trigger.icon} label={name} size="lg" />
          ) : (
            <AgentMark
              slug={session.agent_name ?? space.dm_agent_name ?? DEFAULT_AGENT_SLUG}
              size={28}
              // 36px, the `lg` avatar column (`w-10`): the 40px tile would overflow it.
              tile={36}
              label={name}
            />
          )
        ) : (
          <UserAvatar email={session.owner_email ?? ''} name={name} avatarUrl={session.owner_avatar_url} size="lg" />
        )
      }
      name={name}
      time={{
        iso: session.created_at,
        label: created.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }),
        gutter: gutterTime(created, locale),
        title: created.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' }),
      }}
      toolbar={
        <>
          <ThreadToolbar sessionId={session.session_id} onOpen={onOpen} />
          <RememberThisButton session={session} space={space} />
        </>
      }
    >
      <p className={cn(MESSAGE_TEXT_CLASS, 'text-pretty whitespace-pre-wrap wrap-anywhere')}>
        {threadMessageText(session)}
      </p>
      <ThreadSummary session={session} space={space} onOpen={onOpen} />
    </MessageRow>
  );
}

/**
 * The line under a message: the answering agent's tile, then "3 replies  Last
 * reply 2 hours ago", or "<Agent> is working…" while a turn runs. Hovering the
 * line fills it and swaps the time for "View thread ›", so the whole line reads
 * as the way in. A thread with no counted reply shows the tile and "View
 * thread" only: the row's own time already says when it started.
 */
function ThreadSummary({
  session,
  space,
  onOpen,
}: {
  session: ProjectSession;
  space: ProjectSpace;
  onOpen: () => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const agentName = session.agent_name ?? space.dm_agent_name;
  const agent = agentName ? agentLabel(agentName) : t('agentFallback');
  const working = threadIsWorking(session);
  const replies = session.reply_count ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      // `-mx-1` with `px-1`: the tile lines up with the body text above, and
      // the fill extends past it. `w-full max-w-md`: the target is the line,
      // not only its words, and stops before the line runs the width of a
      // wide window. The fill is instant, like the row's.
      className="group/summary hover:bg-hover focus-visible:ring-ring -mx-1 mt-1 flex w-full max-w-md items-center gap-2 rounded-md px-1 py-1 text-left text-xs outline-none focus-visible:ring-2"
    >
      <AgentMark slug={agentName ?? DEFAULT_AGENT_SLUG} size={14} label={agent} />
      {working ? (
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
          {/* `in-[button]:` — the line is a button, where the spinner would turn
              `text-background` (built for filled buttons) and vanish. */}
          <Loading className="in-[button]:text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{t('working', { agent })}</span>
        </span>
      ) : (
        <>
          {replies > 0 ? (
            <span className="text-foreground shrink-0 font-semibold tabular-nums">
              {t('replies', { count: replies })}
            </span>
          ) : null}
          <span
            className={cn(
              'text-muted-foreground min-w-0 truncate',
              replies > 0 && 'group-hover/summary:hidden group-focus-visible/summary:hidden',
            )}
          >
            {replies > 0 ? t('lastReply', { time: lastReplyLabel(session, locale) }) : t('openThread')}
          </span>
          {replies > 0 ? (
            <span className="text-muted-foreground hidden min-w-0 truncate group-hover/summary:inline group-focus-visible/summary:inline">
              {t('openThread')}
            </span>
          ) : null}
        </>
      )}
      <CaretRightIcon
        aria-hidden
        className="text-muted-foreground ml-auto size-3.5 shrink-0 opacity-0 group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100"
      />
    </button>
  );
}

/** The row's floating actions: reply in the thread (labelled), copy the thread's link. */
function ThreadToolbar({ sessionId, onOpen }: { sessionId: string; onOpen: () => void }) {
  const t = useTranslations('spaces.view');
  const { copied, copy } = useCopy({ toast: false });
  const copyLink = () => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('thread', sessionId);
    void copy(url.toString());
  };
  const linkLabel = copied ? t('linkCopied') : t('copyLink');
  return (
    <>
      {/* The one action a reader came for, so it says its name: "Reply",
          at the icon button's height. `size="xs"` (h-7, no `py-*`), not the
          default size: the default's `py-2` and `has-[>svg]:px-3` survive a
          className override (tailwind-merge keeps variant classes), which
          left the icon a content box shorter than itself, off centre. */}
      <Hint label={t('replyInThread')} side="top">
        <Button variant="ghost" size="xs" aria-label={t('replyInThread')} onClick={onOpen} className="gap-1 rounded-md text-xs">
          <ChatTeardropTextIcon className="size-3.5 shrink-0" />
          {t('reply')}
        </Button>
      </Hint>
      <Hint label={linkLabel} side="top">
        <Button variant="ghost" size="icon-sm" aria-label={linkLabel} onClick={copyLink}>
          {copied ? <SolidCheckIcon className="size-3.5 shrink-0" /> : <LinkSimpleIcon className="size-3.5 shrink-0" />}
        </Button>
      </Hint>
    </>
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
                'hover:bg-hover focus-visible:ring-ring flex w-full items-center gap-3 px-5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset',
                session.session_id === selectedId && 'bg-active hover:bg-active',
              )}
            >
              <SessionStatusMark status={sessionDisplayStatus(session)} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{sessionDisplayLabel(session)}</span>
              <time dateTime={session.updated_at} className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {relativeTime(session.updated_at, locale)}
              </time>
            </button>
          </li>
        ))}
      </ul>
      {threads.hasNextPage ? <LoadEarlier threads={threads} /> : null}
    </div>
  );
}
