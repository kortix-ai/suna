'use client';

import type { ProjectSpace } from '@kortix/sdk';
import { ChatsCircleIcon, FunnelSimpleIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { AgentMark } from '../../internal/components/agent-mark';
import { useSessionNeedsYouCounts } from '../../internal/hooks/use-review-session-summary';
import { useDebounce } from '../../internal/hooks/use-debounced-value';
import { Button } from '../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { UserAvatar } from '../../primitives/user-avatar';
import { useUiViewerId } from '../../providers/ui-provider';
import type { SessionDisplayStatus } from '../../session/actions/session-label';
import { participantLabel } from '../../session/participants/session-participants';
import { SessionStatusMark } from '../sidebar/session-status-mark';
import {
  agentLabel,
  spaceRoster,
  THREAD_ACTIVITIES,
  THREAD_STATUSES,
  threadActivitySince,
  threadFiltersFromParams,
  type ThreadActivity,
  type ThreadFilters,
  type ThreadStatus,
  threadStatus,
} from './space-timeline';
import { SpaceThreadList, type SpaceThreads, useSpaceThreads } from './space-timeline-view';

/** Milliseconds between the last keystroke and the server search. */
const SEARCH_DEBOUNCE_MS = 250;
/** Shorter queries do not search: one letter matches nearly every thread. */
const SEARCH_MIN_CHARS = 2;
/** The URL keys of the search and the filters. */
const FILTER_PARAMS = ['q', 'status', 'by', 'agent', 'active'] as const;
type FilterParam = (typeof FILTER_PARAMS)[number];
/** The radio value of a facet's "Any" row (Radix needs a non-empty value). */
const ANY = 'any';

/** The session list's mark for each Status value, so a row and its filter look the same. */
const STATUS_MARK: Record<ThreadStatus, SessionDisplayStatus> = {
  working: 'running',
  'needs-you': 'needs-you',
  failed: 'failed',
  done: 'done',
};
const STATUS_KEY = { working: 'working', 'needs-you': 'needsYou', failed: 'failed', done: 'done' } as const;

/**
 * The Threads tab of a channel or DM: a search over titles and first prompts,
 * one Filter menu (Status, Started by, Agent, Activity), the active filters
 * as removable tokens, and the rows. Search, person, agent and activity run
 * on the server; Status reads the loaded rows, as on the Sessions page. The
 * URL holds every value (`?q=&status=&by=&agent=&active=`).
 */
export function SpaceThreadsTab({
  projectId,
  space,
  threads,
  selectedId,
  onOpenThread,
  params,
  setParams,
}: {
  projectId: string;
  space: ProjectSpace;
  /** The space's unfiltered threads (the Chat tab's list): the people and agents the menu offers. */
  threads: SpaceThreads;
  selectedId: string | null;
  onOpenThread: (sessionId: string) => void;
  params: { get(name: string): string | null };
  setParams: (change: (params: URLSearchParams) => void) => void;
}) {
  const t = useTranslations('spaces.view');
  const tf = useTranslations('spaces.view.threadFilter');
  const viewerId = useUiViewerId();
  const filters = threadFiltersFromParams(params, space.kind);
  const setParam = (key: FilterParam, value: string | null) =>
    setParams((next) => (value ? next.set(key, value) : next.delete(key)));

  const updatedAfter = useMemo(
    () => (filters.active ? threadActivitySince(filters.active, new Date()) : undefined),
    [filters.active],
  );
  const filtered = useProjectThreads(projectId, space, filters, updatedAfter);
  const needsYou = useSessionNeedsYouCounts(projectId);
  const rows = useMemo(
    () =>
      filters.status
        ? filtered.sessions.filter((session) => threadStatus(session, needsYou[session.session_id]) === filters.status)
        : filtered.sessions,
    [filtered.sessions, filters.status, needsYou],
  );

  const roster = useMemo(() => spaceRoster(threads.sessions, space.dm_agent_name), [threads.sessions, space.dm_agent_name]);
  const people = roster.people.filter((person) => person.id !== viewerId);
  const personName = (id: string) => {
    const person = roster.people.find((candidate) => candidate.id === id);
    const row = filtered.sessions.find((session) => session.created_by === id);
    return (
      participantLabel({ name: person?.name ?? row?.owner_name ?? null, email: person?.email ?? row?.owner_email ?? null }) ||
      t('authorFallback')
    );
  };
  const statusLabel = (status: ThreadStatus) => tf(`statusValue.${STATUS_KEY[status]}`);
  const activityLabel = (active: ThreadActivity) => tf(`activityValue.${active}`);
  const byLabel = (by: string) => (by === 'me' || by === viewerId ? tf('me') : personName(by));

  const tokens: FilterToken<FilterParam>[] = [];
  if (filters.status) {
    tokens.push({
      key: 'status',
      facet: tf('status'),
      label: statusLabel(filters.status),
      icon: <SessionStatusMark status={STATUS_MARK[filters.status]} />,
    });
  }
  if (filters.by) tokens.push({ key: 'by', facet: tf('startedBy'), label: byLabel(filters.by) });
  if (filters.agent) {
    tokens.push({
      key: 'agent',
      facet: tf('agent'),
      label: agentLabel(filters.agent),
      icon: <AgentMark slug={filters.agent} size={14} />,
    });
  }
  if (filters.active) tokens.push({ key: 'active', facet: tf('activity'), label: activityLabel(filters.active) });
  const filtering = tokens.length > 0 || filters.q.length >= SEARCH_MIN_CHARS;

  const clearAll = () => setParams((next) => FILTER_PARAMS.forEach((key) => next.delete(key)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-3 pb-1">
        <FilterSearch
          value={filters.q}
          placeholder={tf('search')}
          minChars={SEARCH_MIN_CHARS}
          onSearch={(q) => setParam('q', q || null)}
        />
        <ThreadFilterMenu
          kind={space.kind}
          filters={filters}
          people={people}
          agents={roster.agents}
          statusLabel={statusLabel}
          activityLabel={activityLabel}
          byLabel={byLabel}
          onChange={setParam}
        />
        <FilterTokens tokens={tokens} onRemove={(key) => setParam(key, null)} onClear={clearAll} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SpaceThreadList
          projectId={projectId}
          threads={filtered}
          sessions={rows}
          selectedId={selectedId}
          onOpenThread={onOpenThread}
          empty={
            filtering ? (
              <EmptyState
                className="min-h-full"
                media={<EmptyArt icon={MagnifyingGlassIcon} />}
                title={tf('noMatch')}
                description={tf('noMatchHint')}
                action={
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={clearAll}>
                    <XIcon className="size-3.5 shrink-0" />
                    {tf('clearFilters')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                className="min-h-full"
                media={<EmptyArt icon={ChatsCircleIcon} />}
                title={t('threadsEmptyTitle')}
                description={t('threadsEmpty')}
              />
            )
          }
        />
      </div>
    </div>
  );
}

/** The space's threads under the server-side filters. No filter: the Chat tab's cache entry. */
function useProjectThreads(projectId: string, space: ProjectSpace, filters: ThreadFilters, updatedAfter: string | undefined) {
  const by = filters.by;
  return useSpaceThreads(projectId, space.space_id, {
    q: filters.q.length >= SEARCH_MIN_CHARS ? filters.q : undefined,
    startedBy: by === 'me' ? 'me' : undefined,
    createdBy: by && by !== 'me' ? by : undefined,
    agent: filters.agent ?? undefined,
    updatedAfter,
    keepPreviousData: true,
  });
}

/** One quiet menu: a submenu per facet, each a single choice with "Any" first. A DM has no person or agent facet. */
function ThreadFilterMenu({
  kind,
  filters,
  people,
  agents,
  statusLabel,
  activityLabel,
  byLabel,
  onChange,
}: {
  kind: 'channel' | 'dm';
  filters: ThreadFilters;
  people: ReturnType<typeof spaceRoster>['people'];
  agents: readonly string[];
  statusLabel: (status: ThreadStatus) => string;
  activityLabel: (active: ThreadActivity) => string;
  byLabel: (by: string) => string;
  onChange: (key: FilterParam, value: string | null) => void;
}) {
  const tf = useTranslations('spaces.view.threadFilter');
  const pick = (key: FilterParam) => (value: string) => onChange(key, value === ANY ? null : value);
  return (
    <FilterMenu>
      <Facet label={tf('status')} value={filters.status ? statusLabel(filters.status) : tf('any')}>
        <DropdownMenuRadioGroup value={filters.status ?? ANY} onValueChange={pick('status')}>
          <DropdownMenuRadioItem value={ANY}>{tf('any')}</DropdownMenuRadioItem>
          {THREAD_STATUSES.map((status) => (
            <DropdownMenuRadioItem key={status} value={status}>
              <SessionStatusMark status={STATUS_MARK[status]} />
              {statusLabel(status)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </Facet>
      {kind === 'channel' ? (
        <Facet label={tf('startedBy')} value={filters.by ? byLabel(filters.by) : tf('anyone')} wide>
          <DropdownMenuRadioGroup value={filters.by ?? ANY} onValueChange={pick('by')}>
            <DropdownMenuRadioItem value={ANY}>{tf('anyone')}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="me">{tf('me')}</DropdownMenuRadioItem>
            {people.length > 0 ? <DropdownMenuSeparator /> : null}
            {people.map((person) => {
              const name = participantLabel(person);
              return (
                <DropdownMenuRadioItem key={person.id} value={person.id}>
                  <UserAvatar size="xs" name={name} email={person.email ?? ''} avatarUrl={person.avatarUrl} />
                  <span className="min-w-0 truncate">{name}</span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </Facet>
      ) : null}
      {kind === 'channel' && (agents.length > 0 || filters.agent) ? (
        <Facet label={tf('agent')} value={filters.agent ? agentLabel(filters.agent) : tf('anyAgent')} wide>
          <DropdownMenuRadioGroup value={filters.agent ?? ANY} onValueChange={pick('agent')}>
            <DropdownMenuRadioItem value={ANY}>{tf('anyAgent')}</DropdownMenuRadioItem>
            {agents.map((agent) => (
              <DropdownMenuRadioItem key={agent} value={agent}>
                <AgentMark slug={agent} size={14} />
                <span className="min-w-0 truncate">{agentLabel(agent)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Facet>
      ) : null}
      <Facet label={tf('activity')} value={filters.active ? activityLabel(filters.active) : tf('anyTime')}>
        <DropdownMenuRadioGroup value={filters.active ?? ANY} onValueChange={pick('active')}>
          <DropdownMenuRadioItem value={ANY}>{tf('anyTime')}</DropdownMenuRadioItem>
          {THREAD_ACTIVITIES.map((active) => (
            <DropdownMenuRadioItem key={active} value={active}>
              {activityLabel(active)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </Facet>
    </FilterMenu>
  );
}

/**
 * The search field of a channel tab's toolbar (Threads, Links). The text is
 * local while typing; `onSearch` gets the settled query ('' below `minChars`),
 * and Esc clears it. A new `value` (Clear, the back button) replaces the text.
 */
export function FilterSearch({
  value,
  placeholder,
  minChars = 1,
  onSearch,
}: {
  value: string;
  placeholder: string;
  minChars?: number;
  onSearch: (q: string) => void;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const debounced = useDebounce(text.trim(), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    const q = debounced.length >= minChars ? debounced : '';
    if (q !== value) onSearch(q);
    // Only a settled keystroke searches; a new `value` resets `text` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return (
    <InputGroupSearch className="max-w-64 min-w-40 flex-1">
      <InputGroupSearchIcon>
        <MagnifyingGlassIcon />
      </InputGroupSearchIcon>
      <InputGroupSearchInput
        size="xs"
        type="search"
        placeholder={placeholder}
        aria-label={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !text) return;
          event.stopPropagation();
          setText('');
          onSearch('');
        }}
      />
    </InputGroupSearch>
  );
}

/** The quiet "Filter" button and its menu; the children are `Facet` rows. */
export function FilterMenu({ children }: { children: ReactNode }) {
  const tf = useTranslations('spaces.view.threadFilter');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          <FunnelSimpleIcon className="size-4 shrink-0" />
          {tf('filter')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 p-1">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type FilterToken<K extends string> = { key: K; facet: string; label: string; icon?: ReactNode };

/** The active filters as removable tokens, then Clear. */
export function FilterTokens<K extends string>({
  tokens,
  onRemove,
  onClear,
}: {
  tokens: readonly FilterToken<K>[];
  onRemove: (key: K) => void;
  onClear: () => void;
}) {
  const tf = useTranslations('spaces.view.threadFilter');
  if (tokens.length === 0) return null;
  return (
    <>
      {tokens.map((token) => (
        <Button
          key={token.key}
          variant="secondary"
          size="xs"
          aria-label={tf('remove', { facet: token.facet, value: token.label })}
          onClick={() => onRemove(token.key)}
          className="max-w-48 gap-1.5"
        >
          {token.icon}
          <span className="min-w-0 truncate">{token.label}</span>
          <Close className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      ))}
      <Button variant="ghost" size="xs" onClick={onClear} className="text-muted-foreground">
        {tf('clear')}
      </Button>
    </>
  );
}

/** A facet row: its name, its current value muted on the right, its choices in a submenu. */
export function Facet({ label, value, wide, children }: { label: string; value: string; wide?: boolean; children: ReactNode }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-muted-foreground max-w-24 truncate text-xs">{value}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={wide ? 'max-h-80 w-56 overflow-y-auto p-1' : 'w-48 p-1'}>
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
