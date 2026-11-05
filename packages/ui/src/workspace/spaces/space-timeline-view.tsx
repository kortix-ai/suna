'use client';

import type { ProjectSession, ProjectSpace } from '@kortix/sdk';
import { type UseProjectSessionsOptions, useFeatureFlag, useProjectSessions, useSessionNeedsYou } from '@kortix/sdk/react';
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
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SpaceMentionContext } from '../../session/composer/menus/space-mentions';

import { useLocale, useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { useSessionNeedsYouCounts, useSessionsAwaitingAnswer } from '../../internal/hooks/use-review-session-summary';
import { useCopy } from '../../internal/hooks/use-copy';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { UserAvatar } from '../../primitives/user-avatar';
import { sessionDisplayLabel, sessionDisplayStatus } from '../../session/actions/session-label';
import { participantLabel } from '../../session/participants/session-participants';
import { MentionChip } from '../../session/thread/mention-chip';
import { TypingIndicator, useElapsedLabel } from '../../session/thread/typing-indicator';
import { formatDuration } from '../../internal/session-types';
import { MESSAGE_TEXT_CLASS, MessageRow } from '../../session/turn/message-row';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { RememberThisButton } from '../memory/remember-this';
import { SessionStatusMark } from '../../session/list/session-status-mark';
import {
  agentLabel,
  buildSpaceTimeline,
  DEFAULT_AGENT_SLUG,
  dayKind,
  firstPromptTruncated,
  gutterTime,
  lastReplyLabel,
  messageMentionSegments,
  type MentionCandidate,
  kortixRootText,
  postSegments,
  rootPostAuthor,
  threadIsWorking,
  threadMessageText,
  threadStatus,
  type TimelineDay,
} from './space-timeline';
import { oneLineWithoutEmails, spaceDisplayName } from './space-identity';
import { useMentionNames } from './space-people';
import { type Principal, PrincipalHover, useMemberIdByName } from './principal-card';
import { usePersonalSpaceName } from './use-personal-space-name';

/** What a thread waits on the viewer for: none, an answer (question or approval), or a review. */
type NeedsYou = 'answer' | 'review' | null;

/**
 * The sidebar session list's needs-you read (`useSessionNeedsYouCounts`,
 * `useSessionsAwaitingAnswer`), as one lookup per thread: the Threads filter's
 * "Needs you" (`threadStatus`) and the row's mark agree by construction.
 */
function useThreadNeedsYou(projectId: string): (session: ProjectSession) => NeedsYou {
  const counts = useSessionNeedsYouCounts(projectId);
  const awaitingAnswer = useSessionsAwaitingAnswer(projectId);
  return (session) =>
    threadStatus(session, counts[session.session_id]) !== 'needs-you'
      ? null
      : awaitingAnswer.has(session.session_id)
        ? 'answer'
        : 'review';
}

/**
 * The space's threads: top-level sessions only (`parent: 'root'`, a child
 * thread is part of its parent). Polls page one every 5 s while an agent works
 * so the "is working" line settles, else every 15 s so a member's new thread
 * shows up. Active threads sort first, so page one holds them; older pages the
 * viewer loaded are not re-read on each tick. `filters` narrow it on the
 * server (the Threads tab); without them it is the Chat tab's list, one cache
 * entry for both tabs.
 */
export function useSpaceThreads(
  projectId: string,
  spaceId: string | undefined,
  filters?: Pick<UseProjectSessionsOptions, 'q' | 'startedBy' | 'createdBy' | 'agent' | 'updatedAfter' | 'keepPreviousData'>,
) {
  return useProjectSessions(projectId, {
    ...filters,
    spaceId,
    parent: 'root',
    enabled: !!spaceId,
    // A thread whose hidden worker runs (`active_child_agent`) polls like a working one.
    refetchInterval: (sessions) => (sessions.some((session) => threadIsWorking(session) || !!session.active_child_agent) ? 5_000 : 15_000),
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
  projectId,
  space,
  threads,
  selectedId,
  onOpenThread,
}: {
  projectId: string;
  space: ProjectSpace;
  threads: SpaceThreads;
  selectedId: string | null;
  onOpenThread: (sessionId: string) => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const days = useMemo(() => buildSpaceTimeline(threads.sessions), [threads.sessions]);
  const loading = threads.isLoading || threads.isScanning;
  const needsYou = useThreadNeedsYou(projectId);
  // Chat (`chat`): Kortix's newest reply shows under each message.
  const oneChat = useFeatureFlag(projectId, 'chat').enabled;
  const now = new Date();

  const dayLabel = (day: TimelineDay) => {
    const kind = dayKind(day.date, now);
    if (kind === 'today') return t('today');
    if (kind === 'yesterday') return t('yesterday');
    return day.date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  };

  // A channel with no thread yet: the welcome at the bottom, where it always sits.
  if (space.kind === 'channel' && !loading && threads.data && !threads.hasNextPage && days.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mt-auto pt-4 pb-3">
          <SpaceWelcome space={space} empty />
        </div>
      </div>
    );
  }

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
                    projectId={projectId}
                    session={session}
                    space={space}
                    needsYou={needsYou(session)}
                    latestReply={oneChat}
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
  const personalName = usePersonalSpaceName();
  if (space.kind === 'dm' && space.dm_agent_name) {
    // A private space with one agent: the space's name over who sees it.
    const agent = agentLabel(space.dm_agent_name);
    return (
      <div className="space-y-3 px-5 pt-16 pb-6">
        <AgentMark slug={space.dm_agent_name} size={42} label={agent} />
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{spaceDisplayName(space, personalName)}</h2>
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
  projectId,
  session,
  space,
  needsYou,
  latestReply = false,
  selected,
  onOpen,
}: {
  projectId: string;
  session: ProjectSession;
  space: ProjectSpace;
  needsYou: NeedsYou;
  /** Chat (`chat`): the agent's newest reply shows under the message. */
  latestReply?: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const created = new Date(session.created_at);
  // A trigger's run reads as the trigger: its name and its type's glyph.
  const trigger = triggerAuthor(session);
  // A thread Kortix started (Chat) reads as Kortix's own message.
  const byKortix = kortixRootText(session) !== null;
  // A trigger or an API key starts a thread as a service account: an agent tile, not a person.
  const machine = trigger !== null || byKortix || session.owner_type === 'service_account';
  // The profile name, never a raw email (`participantLabel`).
  const name = trigger
    ? trigger.name
    : byKortix
      ? agentLabel(rootPostAuthor(session) ?? session.agent_name ?? space.dm_agent_name ?? t('agentFallback'))
      : machine
      ? agentLabel(session.owner_name || t('agentFallback'))
      : participantLabel({ name: session.owner_name ?? null, email: session.owner_email ?? null }) ||
        t('authorFallback');

  // Who the avatar and the name open: the agent of a Kortix post, the person who wrote it; a trigger or an API key has no card.
  const agentSlug = byKortix ? (rootPostAuthor(session) ?? session.agent_name ?? space.dm_agent_name) : null;
  const principal: Principal | null = byKortix
    ? agentSlug
      ? { kind: 'agent', name: agentSlug }
      : null
    : machine
      ? null
      : {
          kind: 'person',
          userId: session.created_by ?? null,
          name,
          email: session.owner_email ?? null,
          avatarUrl: session.owner_avatar_url ?? null,
        };
  const card = (node: ReactNode, focusable = true) =>
    principal ? (
      <PrincipalHover projectId={projectId} principal={principal} focusable={focusable}>
        {node}
      </PrincipalHover>
    ) : (
      node
    );
  return (
    <MessageRow
      selected={selected}
      avatar={card(
        machine ? (
          trigger ? (
            <EntityAvatar icon={trigger.icon} label={name} size="lg" />
          ) : (
            <AgentMark
              slug={(byKortix ? rootPostAuthor(session) : null) ?? session.agent_name ?? space.dm_agent_name ?? DEFAULT_AGENT_SLUG}
              size={28}
              // 36px, the `lg` avatar column (`w-10`): the 40px tile would overflow it.
              tile={36}
              label={name}
            />
          )
        ) : (
          <UserAvatar email={session.owner_email ?? ''} name={name} avatarUrl={session.owner_avatar_url} colorKey={session.created_by} size="lg" />
        ),
        false,
      )}
      name={card(<span className="truncate hover:underline">{name}</span>)}
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
      <ThreadPrompt projectId={projectId} session={session} onOpen={onOpen} />
      {latestReply ? (
        <ThreadReplyLine projectId={projectId} session={session} space={space} needsYou={needsYou} showReply={!byKortix} onOpen={onOpen} />
      ) : (
        <ThreadSummary session={session} space={space} needsYou={needsYou} onOpen={onOpen} />
      )}
    </MessageRow>
  );
}

/**
 * Chat (`chat`): every message is a thread, and its ONE reply line sits under
 * it: the agent's tile, then three dots while it works, a "Needs you" mark
 * while it waits on the viewer, else its newest reply on one line
 * (`result_excerpt`, stamped at turn end); the reply count and the last
 * activity at the end. The whole line opens the thread.
 */
function ThreadReplyLine({
  projectId,
  session,
  space,
  needsYou,
  showReply,
  onOpen,
}: {
  projectId: string;
  session: ProjectSession;
  space: ProjectSpace;
  needsYou: NeedsYou;
  /** False for a thread Kortix started: its top message is already the agent's. */
  showReply: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('spaces.view');
  const tf = useTranslations('spaces.view.threadFilter');
  const locale = useLocale();
  const agentName = session.agent_name ?? space.dm_agent_name;
  const agent = agentName ? agentLabel(agentName) : t('agentFallback');
  const working = threadIsWorking(session);
  const replies = session.reply_count ?? 0;
  const names = useMentionNames(projectId);
  const tTurn = useTranslations('sessionUi.turn');
  // An ask that waits on the person (its hidden workers' included): the line says so and opens the thread.
  const asks = useSessionNeedsYou(projectId, session.session_id);
  const firstAsk = asks.asks[0];
  const askHeader = firstAsk ? (firstAsk.question?.questions[0]?.header || firstAsk.title) : null;
  // The wait, said: "Starting…" while the thread's computer comes up, else "Working · 0:42".
  // A stopped thread that works again is waking its computer: a start too.
  const booting = session.status === 'provisioning' || session.status === 'queued' || session.status === 'branching' || (working && session.status === 'stopped');
  const elapsed = useElapsedLabel(working ? (session.working?.since ?? session.updated_at) : null, formatDuration);
  const waitDetail = booting ? tTurn('starting') : elapsed ? tTurn('workingFor', { time: elapsed }) : null;
  // An agent's own post: its reply line starts with the first reply. Mentions read as names; no address shows.
  const reply = showReply || replies > 0 ? oneLineWithoutEmails(names(session.result_excerpt ?? '')) || null : null;
  // The thread's own turn ended ("On it."), its hidden worker still runs: say who works.
  const childAgent = !working && !needsYou && !asks.needsYou ? (session.active_child_agent ?? null) : null;
  // Nothing to say yet (no reply, no work, nothing waiting): no line, as in Slack.
  if (!needsYou && !asks.needsYou && !working && !childAgent && !reply && replies === 0) return null;
  const time = <time dateTime={session.updated_at}>{relativeTime(session.updated_at, locale)}</time>;
  if (childAgent) {
    return (
      <div className="-mx-1 mt-1 flex w-full max-w-2xl min-w-0 items-center gap-1 rounded-md pl-1">
        <PrincipalHover projectId={projectId} principal={{ kind: 'agent', name: childAgent }} className="shrink-0">
          <AgentMark slug={childAgent} size={14} label={agentLabel(childAgent)} />
        </PrincipalHover>
        <button
          type="button"
          onClick={onOpen}
          className="hover:bg-hover focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-left outline-none focus-visible:ring-2"
        >
          <TypingIndicator name={agentLabel(childAgent)} className="h-5" detail={tTurn('agentIsWorking', { agent: agentLabel(childAgent) })} />
          <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-xs tabular-nums">
            {replies > 0 ? `${t('replies', { count: replies })} · ` : ''}
            {time}
          </span>
        </button>
      </div>
    );
  }
  // Replies without a text to show: the count and the time alone, no empty face.
  if (!needsYou && !asks.needsYou && !working && !reply) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-hover focus-visible:ring-ring text-muted-foreground -mx-1 mt-1 flex w-fit items-center gap-1 rounded-md px-1 py-1 text-xs tabular-nums outline-none focus-visible:ring-2"
      >
        <span className="text-foreground font-medium">{t('replies', { count: replies })}</span>
        <span aria-hidden>·</span>
        {time}
      </button>
    );
  }
  return (
    // The agent's tile opens its card; the rest of the line opens the thread (two controls, never one inside the other).
    <div className="-mx-1 mt-1 flex w-full max-w-2xl min-w-0 items-center gap-1 rounded-md pl-1">
      <PrincipalHover projectId={projectId} principal={{ kind: 'agent', name: agentName ?? DEFAULT_AGENT_SLUG }} className="shrink-0">
        <AgentMark slug={agentName ?? DEFAULT_AGENT_SLUG} size={14} label={agent} />
      </PrincipalHover>
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-hover focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-left outline-none focus-visible:ring-2"
      >
        {asks.needsYou ? (
          <span className="text-foreground flex min-w-0 items-center gap-1 text-xs font-medium">
            <SessionStatusMark status="needs-you" waitingOn="answer" />
            <span className="truncate" title={askHeader ?? undefined}>
              {askHeader ? tTurn('needsYouOn', { header: askHeader }) : tf('statusValue.needsYou')}
            </span>
          </span>
        ) : needsYou ? (
          <span className="text-foreground flex shrink-0 items-center gap-1 text-xs font-medium">
            <SessionStatusMark status="needs-you" waitingOn={needsYou} />
            {tf('statusValue.needsYou')}
          </span>
        ) : working ? (
          <TypingIndicator name={agent} className="h-5" detail={waitDetail} detailDelayMs={2000} />
        ) : reply ? (
          <span className="text-foreground min-w-0 truncate text-sm" title={reply}>
            {reply}
          </span>
        ) : null}
        <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-xs tabular-nums">
          {replies > 0 ? `${t('replies', { count: replies })} · ` : ''}
          {time}
        </span>
      </button>
    </div>
  );
}

/** A person's message text, its `@` mentions of the space's people and agents drawn as chips with cards. */
function MessageText({ projectId, text }: { projectId: string; text: string }) {
  const source = useContext(SpaceMentionContext);
  const candidates = useMemo<MentionCandidate[]>(
    () =>
      source
        ? [
            ...source.people.flatMap((p) =>
              [p.token, p.name].map((token) => ({ token, mention: { kind: 'person' as const, label: p.name, userId: p.userId } })),
            ),
            ...source.agents.flatMap((a) =>
              [a.name, a.label].map((token) => ({ token, mention: { kind: 'agent' as const, label: a.label, agent: a.name } })),
            ),
          ]
        : [],
    [source],
  );
  const segments = useMemo(() => messageMentionSegments(text, candidates), [text, candidates]);
  return (
    <>
      {segments.map((segment, i) =>
        segment.mention ? <MentionCard key={i} projectId={projectId} mention={segment.mention} /> : <span key={i}>{segment.text}</span>,
      )}
    </>
  );
}

/** A resolved @mention: its chip opens the person's or agent's card. An unresolved one stays a plain chip. */
function MentionCard({ projectId, mention }: { projectId: string; mention: NonNullable<ReturnType<typeof postSegments>[number]['mention']> }) {
  const chip = <MentionChip kind={mention.kind === 'person' ? 'person' : 'agent'} label={mention.label} />;
  // A post stored before mentions carried ids: the member with that display name.
  const byName = useMemberIdByName(projectId, mention.kind === 'person' && !mention.userId ? mention.label : null);
  const userId = mention.userId ?? byName;
  const principal: Principal | null =
    mention.kind === 'agent' && mention.agent
      ? { kind: 'agent', name: mention.agent }
      : mention.kind === 'person' && userId
        ? { kind: 'person', userId, name: mention.label }
        : null;
  if (!principal) return chip;
  return (
    <PrincipalHover projectId={projectId} principal={principal} className="align-baseline">
      {chip}
    </PrincipalHover>
  );
}

/**
 * The thread's first prompt, clamped to 6 lines with "…". When it runs longer,
 * a quiet "Show more" unfolds it in place and "Show less" folds it back. A
 * prompt the server cut (`firstPromptTruncated`) ends in "…", and its "Show
 * more" opens the thread, whose transcript holds the whole message.
 */
function ThreadPrompt({ projectId, session, onOpen }: { projectId: string; session: ProjectSession; onOpen: () => void }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const truncated = firstPromptTruncated(session);
  const text = threadMessageText(session);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p
        ref={ref}
        className={cn(
          MESSAGE_TEXT_CLASS,
          'text-pretty whitespace-pre-wrap wrap-anywhere',
          !expanded && 'line-clamp-6',
        )}
      >
        {kortixRootText(session) !== null ? (
          // A space post: its resolved mentions as chips.
          postSegments(text, session.metadata?.chat_root_mentions).map((segment, i) =>
            segment.mention ? (
              <MentionCard key={i} projectId={projectId} mention={segment.mention} />
            ) : (
              <span key={i}>{segment.text}</span>
            ),
          )
        ) : (
          // A person's message: its `@` mentions of the space's people and agents as chips.
          <MessageText projectId={projectId} text={truncated ? `${text}…` : text} />
        )}
      </p>
      {truncated || overflows || expanded ? (
        <button
          type="button"
          aria-expanded={truncated ? undefined : expanded}
          onClick={truncated ? onOpen : () => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground hit-area-x-2 hit-area-y-2 focus-visible:ring-ring mt-0.5 self-start rounded-sm text-xs font-medium transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:outline-none"
        >
          {expanded ? t.raw('text94ea9b1d33a0') : t.raw('textf5c9bd131486')}
        </button>
      ) : null}
    </>
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
  needsYou,
  onOpen,
}: {
  session: ProjectSession;
  space: ProjectSpace;
  needsYou: NeedsYou;
  onOpen: () => void;
}) {
  const t = useTranslations('spaces.view');
  const tf = useTranslations('spaces.view.threadFilter');
  const locale = useLocale();
  const agentName = session.agent_name ?? space.dm_agent_name;
  const agent = agentName ? agentLabel(agentName) : t('agentFallback');
  const working = threadIsWorking(session);
  const replies = session.reply_count ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      // `-mx-1` with `pl-1`: the tile lines up with the body text above, and
      // the fill extends past it. `pr-1.5`: the caret sits inside the fill,
      // not on its edge. `w-full max-w-md`: the target is the line, not only
      // its words, and stops before the line runs the width of a wide window.
      // The fill is instant, like the row's.
      className="group/summary hover:bg-hover focus-visible:ring-ring -mx-1 mt-1 flex w-full max-w-md items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-left text-xs outline-none focus-visible:ring-2"
    >
      <AgentMark slug={agentName ?? DEFAULT_AGENT_SLUG} size={14} label={agent} />
      {/* A pending review, question or approval wins over a turn in flight,
          as in the Threads filter: the session list's mark, then "Needs you". */}
      {needsYou ? (
        <span className="text-foreground flex shrink-0 items-center gap-1 font-medium">
          <SessionStatusMark status="needs-you" waitingOn={needsYou} />
          {tf('statusValue.needsYou')}
        </span>
      ) : null}
      {working && !needsYou ? (
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

/**
 * The Threads tab's rows, last activity first. `sessions` are the rows to
 * show (the tab filters `threads`); `empty` is drawn when there are none.
 */
export function SpaceThreadList({
  projectId,
  threads,
  sessions,
  empty,
  selectedId,
  onOpenThread,
}: {
  projectId: string;
  threads: SpaceThreads;
  sessions: readonly ProjectSession[];
  empty: ReactNode;
  selectedId: string | null;
  onOpenThread: (sessionId: string) => void;
}) {
  const locale = useLocale();
  const needsYou = useThreadNeedsYou(projectId);
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [sessions],
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
      <div className="flex min-h-full flex-col">
        {empty}
        {/* A Status filter reads the loaded pages: older ones may still match. */}
        {threads.hasNextPage ? <LoadEarlier threads={threads} /> : null}
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
              <SessionStatusMark
                status={needsYou(session) ? 'needs-you' : sessionDisplayStatus(session)}
                waitingOn={needsYou(session) ?? undefined}
              />
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
