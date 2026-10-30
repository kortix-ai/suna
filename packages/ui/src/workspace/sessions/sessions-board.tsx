'use client';

import {
  createProjectSession,
  stopProjectSession,
  type ProjectSession,
  type SessionBoardState,
} from '@kortix/sdk';
import { qk, useProjectSessions, useVisibleAgents } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, MagnifyingGlassIcon, RobotIcon, SquareIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useTranslations } from '../../i18n';
import { useSessionNeedsYouCounts } from '../../internal/hooks/use-review-session-summary';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { Hint } from '../../primitives/hint';
import { InputGroupSearch, InputGroupSearchIcon, InputGroupSearchInput } from '../../primitives/input-group';
import { Kbd } from '../../primitives/kbd';
import Loading from '../../primitives/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink, useUiRouter } from '../../providers/ui-provider';
import { sessionCanBeStopped, sessionDisplayLabel } from '../../session/actions/session-label';
import { buildNewSessionCreateInput } from '../layout/new-session-create';
import {
  boardKeyAction,
  moveBoardSelection,
  parseBoardInput,
  parseDispatch,
} from './board-dispatch';
import {
  boardActivityAt,
  boardAgentLabel,
  boardAgentOf,
  boardRowOrder,
  boardStateOf,
  compactAge,
  groupBoard,
  matchesBoardFilters,
  type BoardGroup,
  type BoardGroupId,
} from './board-grouping';
import { BoardPeek } from './board-peek';
import { BoardStateMark } from './board-state-mark';

/** The board polls while it is open: agents change state every few seconds. */
const BOARD_POLL_MS = 5_000;
/** Rows per page. The board shows the newest activity; Load more reads further back. */
const BOARD_PAGE_SIZE = 100;
const ALL = 'all';
const STATES: readonly SessionBoardState[] = ['working', 'needs_input', 'idle', 'completed', 'failed', 'stopped'];

/** A clock for the rows' ages, once a minute. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The agent board (`/projects/<id>/sessions?view=board`), Claude Code's agent
 * view in Kortix's own look: every session of the project, child sessions
 * included, grouped by what it needs (Pinned, Needs input, Working, Ready for
 * review, Completed, Failed · Stopped). One input on top starts a session
 * (`@agent prompt` or a plain prompt) or filters the board (`s:working`,
 * `a:reviewer`). The list owns the keys: ↑/↓ move, Space peeks, Enter opens,
 * x stops.
 */
export function SessionsBoard({ projectId }: { projectId: string }) {
  const t = useTranslations('multiAgent.board');
  const router = useUiRouter();
  const queryClient = useQueryClient();
  const now = useMinuteClock();
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<string>(ALL);
  const [agentFilter, setAgentFilter] = useState<string>(ALL);
  const [expanded, setExpanded] = useState<ReadonlySet<BoardGroupId>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sessionsQuery = useProjectSessions(projectId, {
    limit: BOARD_PAGE_SIZE,
    refetchInterval: BOARD_POLL_MS,
    pollFirstPageOnly: true,
    refetchOnWindowFocus: true,
  });
  const sessions = sessionsQuery.sessions;
  const needsYou = useSessionNeedsYouCounts(projectId);
  const projectAgents = useVisibleAgents({ projectId });
  const agentNames = useMemo(() => projectAgents.map((agent) => agent.name), [projectAgents]);

  // The agents the filter offers: the project's, plus every handle and agent a row names.
  const filterAgents = useMemo(() => {
    const names = new Set(agentNames);
    for (const session of sessions) {
      const name = boardAgentOf(session);
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [agentNames, sessions]);

  const tokens = useMemo(() => parseBoardInput(input), [input]);
  const filters = useMemo(
    () => ({
      states: [...tokens.states, ...(stateFilter === ALL ? [] : [stateFilter as SessionBoardState])],
      agents: [...tokens.agents, ...(agentFilter === ALL ? [] : [agentFilter])],
    }),
    [tokens, stateFilter, agentFilter],
  );
  const filtering = filters.states.length > 0 || filters.agents.length > 0;

  const visible = useMemo(
    () =>
      sessions.filter((session) =>
        matchesBoardFilters(session, filters, sessionDisplayLabel(session), needsYou[session.session_id] ?? 0),
      ),
    [sessions, filters, needsYou],
  );
  const groups = useMemo(
    () => groupBoard(visible, { needsYouBySession: needsYou, expanded, filtering }),
    [visible, needsYou, expanded, filtering],
  );
  const order = useMemo(() => boardRowOrder(groups), [groups]);
  const byId = useMemo(() => new Map(sessions.map((session) => [session.session_id, session])), [sessions]);
  const peekSession = peekId ? (byId.get(peekId) ?? null) : null;
  // A filter that hides the selection selects nothing: Enter must never open a row you cannot see.
  const selection = selectedId && order.includes(selectedId) ? selectedId : null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });

  const dispatch = useMutation({
    mutationFn: ({ prompt, agent }: { prompt: string; agent?: string }) =>
      createProjectSession(projectId, { initial_prompt: prompt, ...buildNewSessionCreateInput({ agent }) }),
    onSuccess: (session) => {
      setInput('');
      successToast(t('dispatched'), {
        actions: [{ label: t('openSession'), onClick: () => router.push(uiRoutes().session(projectId, session.session_id)) }],
      });
      setSelectedId(session.session_id);
      void invalidate();
    },
    onError: (error) =>
      errorToast(t('dispatchFailed'), { description: error instanceof Error ? error.message : undefined }),
  });

  const stop = useMutation({
    mutationFn: (sessionId: string) => stopProjectSession(projectId, sessionId),
    onSuccess: () => {
      successToast(t('stopped'));
      void invalidate();
    },
    onError: (error) => errorToast(t('stopFailed'), { description: error instanceof Error ? error.message : undefined }),
  });

  const submitInput = () => {
    // Only filter tokens: the board already shows the match. Enter moves to it.
    if (!tokens.rest) {
      if (order[0]) {
        setSelectedId(order[0]);
        listRef.current?.focus();
      }
      return;
    }
    const result = parseDispatch(tokens.rest, agentNames);
    if (result.kind === 'too_short') return setInputError(t('tooShort'));
    if (result.kind === 'dispatch' && !dispatch.isPending) {
      dispatch.mutate({ prompt: result.prompt, ...(result.agent ? { agent: result.agent } : {}) });
    }
  };

  const openSession = (sessionId: string) => router.push(uiRoutes().session(projectId, sessionId));
  const stopSession = (sessionId: string) => {
    const session = byId.get(sessionId);
    if (session && sessionCanBeStopped(session) && !stop.isPending) stop.mutate(sessionId);
  };
  const move = (step: 1 | -1) => {
    const next = moveBoardSelection(order, selection, step);
    setSelectedId(next);
    if (peekId && next) setPeekId(next);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = boardKeyAction(event, event.target as HTMLElement);
    if (!action) return;
    event.preventDefault();
    switch (action) {
      case 'up':
        return move(-1);
      case 'down':
        return move(1);
      case 'peek':
        if (selection) setPeekId(peekId === selection ? null : selection);
        return;
      case 'open':
        if (selection) openSession(selection);
        return;
      case 'stop':
        if (selection) stopSession(selection);
        return;
      case 'close':
        setPeekId(null);
        return;
    }
  };

  const clearFilters = () => {
    setStateFilter(ALL);
    setAgentFilter(ALL);
    setInput(tokens.rest);
  };

  const loaded = sessionsQuery.data !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-4">
      <div className="shrink-0 space-y-2">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitInput();
          }}
        >
          <InputGroupSearch>
            <InputGroupSearchIcon>
              {dispatch.isPending ? <Loading className="size-4 shrink-0" /> : <RobotIcon />}
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setInputError(null);
              }}
              placeholder={t('dispatchPlaceholder')}
              aria-label={t('dispatchLabel')}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? 'board-dispatch-error' : undefined}
              disabled={dispatch.isPending}
            />
          </InputGroupSearch>
        </form>
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          {inputError ? (
            <p id="board-dispatch-error" role="alert" className="text-muted-foreground text-xs">
              {inputError}
            </p>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger size="sm" aria-label={t('stateFilter')} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={ALL}>{t('allStates')}</SelectItem>
                {STATES.map((state) => (
                  <SelectItem key={state} value={state}>
                    {t(`state.${state}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger size="sm" aria-label={t('agentFilter')} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={ALL}>{t('allAgents')}</SelectItem>
                {filterAgents.map((agent) => (
                  <SelectItem key={agent} value={agent}>
                    {agent}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {!loaded && !sessionsQuery.isError ? (
        <div className="space-y-1 pt-4" aria-hidden>
          {['w-56', 'w-40', 'w-64', 'w-44', 'w-52'].map((width) => (
            <div key={width} className="flex items-center gap-3 px-3 py-2">
              <Skeleton className="size-2 shrink-0 rounded-full py-0" />
              <Skeleton className={cn('h-3.5 py-0', width)} />
              <Skeleton className="ml-auto h-3 w-8 shrink-0 py-0" />
            </div>
          ))}
        </div>
      ) : sessionsQuery.isError && sessions.length === 0 ? (
        <ErrorState
          size="sm"
          title={t('loadError')}
          action={
            <Button variant="outline" size="sm" onClick={() => sessionsQuery.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      ) : sessions.length === 0 ? (
        <EmptyState size="sm" icon={RobotIcon} title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : groups.length === 0 ? (
        <EmptyState
          size="sm"
          icon={MagnifyingGlassIcon}
          title={t('noMatches')}
          action={
            <Button variant="outline" size="sm" onClick={clearFilters}>
              {t('clearFilters')}
            </Button>
          }
        />
      ) : (
        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
            <FadedScrollArea fadeColor="from-background" className="pt-2">
              <div
                ref={listRef}
                role="listbox"
                tabIndex={0}
                aria-label={t('listLabel')}
                aria-activedescendant={selection ? `board-row-${selection}` : undefined}
                onKeyDown={onListKeyDown}
                className="focus-visible:ring-ring space-y-4 rounded-md pb-6 outline-none focus-visible:ring-2"
              >
                {groups.map((group) => (
                  <BoardGroupSection
                    key={group.id}
                    group={group}
                    projectId={projectId}
                    now={now}
                    needsYou={needsYou}
                    selectedId={selection}
                    stoppingId={stop.isPending ? (stop.variables ?? null) : null}
                    onSelect={(sessionId) => {
                      setSelectedId(sessionId);
                      setPeekId(sessionId);
                    }}
                    onStop={stopSession}
                    onExpand={() => setExpanded((previous) => new Set(previous).add(group.id))}
                  />
                ))}
                {sessionsQuery.hasNextPage ? (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={sessionsQuery.isFetchingNextPage}
                      onClick={() => sessionsQuery.fetchNextPage()}
                    >
                      {sessionsQuery.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </FadedScrollArea>
          </div>
        </div>
      )}

      {sessions.length > 0 ? (
        <p className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs max-sm:hidden">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t('keys.move')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd className="w-auto">Space</Kbd>
            {t('keys.peek')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd className="w-auto">Enter</Kbd>
            {t('keys.open')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>x</Kbd>
            {t('keys.stop')}
          </span>
        </p>
      ) : null}

      <BoardPeek
        projectId={projectId}
        session={peekSession}
        title={peekSession ? sessionDisplayLabel(peekSession) : ''}
        needsYouCount={peekSession ? (needsYou[peekSession.session_id] ?? 0) : 0}
        onClose={() => {
          setPeekId(null);
          listRef.current?.focus();
        }}
        onMove={move}
      />
    </div>
  );
}

function BoardGroupSection({
  group,
  projectId,
  now,
  needsYou,
  selectedId,
  stoppingId,
  onSelect,
  onStop,
  onExpand,
}: {
  group: BoardGroup;
  projectId: string;
  now: number;
  needsYou: Record<string, number>;
  selectedId: string | null;
  stoppingId: string | null;
  onSelect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onExpand: () => void;
}) {
  const t = useTranslations('multiAgent.board');
  return (
    <section role="group" aria-label={t(`group.${group.id}`)} className="space-y-0.5">
      <h3 className="text-muted-foreground flex h-8 items-center gap-1.5 px-3 text-sm font-medium">
        <span className="truncate">{t(`group.${group.id}`)}</span>
        <span className="text-xs tabular-nums">{group.total}</span>
      </h3>
      {group.sessions.map((session) => (
        <BoardRow
          key={session.session_id}
          session={session}
          projectId={projectId}
          now={now}
          needsYouCount={needsYou[session.session_id] ?? 0}
          selected={selectedId === session.session_id}
          stopping={stoppingId === session.session_id}
          onSelect={onSelect}
          onStop={onStop}
        />
      ))}
      {group.hidden > 0 ? (
        <Button variant="ghost" size="xs" className="text-muted-foreground ml-1" onClick={onExpand}>
          {t('more', { count: group.hidden })}
        </Button>
      ) : null}
    </section>
  );
}

function BoardRow({
  session,
  projectId,
  now,
  needsYouCount,
  selected,
  stopping,
  onSelect,
  onStop,
}: {
  session: ProjectSession;
  projectId: string;
  now: number;
  needsYouCount: number;
  selected: boolean;
  stopping: boolean;
  onSelect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  const t = useTranslations('multiAgent.board');
  const state = boardStateOf(session, needsYouCount);
  const title = sessionDisplayLabel(session);
  const agent = boardAgentLabel(session);
  const excerpt = session.result_excerpt?.replace(/\s+/g, ' ').trim();
  const activity = boardActivityAt(session);
  return (
    <div
      id={`board-row-${session.session_id}`}
      role="option"
      aria-selected={selected}
      data-board-row={session.session_id}
      onClick={() => onSelect(session.session_id)}
      className={cn(
        // Keyboard moves repaint at once: no transition on the selection (motion.md).
        'group/board-row flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-none',
        selected ? 'bg-muted' : 'hover:bg-muted/40',
      )}
    >
      <BoardStateMark state={state} showLabel={false} />
      <span className="text-foreground min-w-0 shrink truncate text-sm sm:max-w-[40%]" title={title}>
        {title}
      </span>
      {agent ? <span className="text-muted-foreground max-w-32 shrink-0 truncate text-xs">{agent}</span> : null}
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs max-sm:hidden" title={excerpt}>
        {excerpt ?? ''}
      </span>
      <time
        dateTime={activity}
        className="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums group-hover/board-row:hidden"
      >
        {compactAge(activity, now)}
      </time>
      <ButtonGroup className="hidden shrink-0 group-hover/board-row:flex">
        <Hint label={t('openSession')}>
          <Button asChild variant="ghost" size="icon-sm" onClick={(event) => event.stopPropagation()}>
            <UiLink href={uiRoutes().session(projectId, session.session_id)} aria-label={t('openSession')}>
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </UiLink>
          </Button>
        </Hint>
        {sessionCanBeStopped(session) ? (
          <Hint label={t('stopSession')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('stopSession')}
              disabled={stopping}
              onClick={(event) => {
                event.stopPropagation();
                onStop(session.session_id);
              }}
            >
              {stopping ? <Loading className="size-3.5 shrink-0" /> : <SquareIcon className="size-3.5 shrink-0" />}
            </Button>
          </Hint>
        ) : null}
      </ButtonGroup>
    </div>
  );
}
