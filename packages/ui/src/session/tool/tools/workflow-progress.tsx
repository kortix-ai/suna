'use client';

import { Button } from '../../../primitives/button';
import { CountBadge } from '../../../primitives/count-badge';
import { Hint } from '../../../primitives/hint';
import Loading from '../../../primitives/loading';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '../../../primitives/tabs';
import { useToolIndent } from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolResultCard } from '../shared/result-card';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  CheckIcon,
  CircleDashedIcon,
  MinusIcon,
  SquareIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useCallback, useId, useMemo, useState } from 'react';
import {
  AGENT_FILTERS,
  agentMatches,
  countAgents,
  elapsedMs,
  formatElapsed,
  groupAgents,
  structuredSummary,
  type AgentFilter,
  type AgentGroup,
  type WorkflowAgentStatus,
  type WorkflowPhaseStatus,
  type WorkflowRun,
  type WorkflowRunAgent,
} from './workflow-run';

/**
 * The body of a workflow card: Claude Code's `/workflows` progress view, in the chat.
 *
 * The script's newest `log()` lines, then one group per phase with its agent count
 * and state (a phase the script declared but has not reached is listed, greyed), and
 * under each phase one dense row per agent. More than {@link FILTER_FROM} agents get a
 * status filter (`f` cycles it, as in Claude Code); ↑ and ↓ move between rows, Enter
 * opens the focused agent's session. A phase longer than {@link CAP_FROM} rows shows its
 * first {@link GROUP_CAP} and a "Show all" button, inside one scroll container for the run.
 *
 * Nothing moves while the run updates: rows append in start order, every number is
 * `tabular-nums`, the elapsed column and the Stop slot keep a fixed width.
 */

/** More agents than this get the status filter. */
const FILTER_FROM = 8;
/** A group with more rows than this (Claude Code's "Large workflow" line) is capped… */
const CAP_FROM = 25;
/** …to this many rows and a "Show all" button. */
const GROUP_CAP = 20;

/**
 * One status mark for a run, a phase or an agent: a spinner while it works, else the
 * outcome. The glyph is decoration; the word beside it is for a screen reader.
 */
export function StateMark({
  status,
  label,
}: {
  status: WorkflowPhaseStatus | WorkflowAgentStatus;
  label: string;
}) {
  return (
    <>
      {status === 'starting' || status === 'running' ? (
        // `Loading` paints itself `text-background` inside a button; an agent row is one.
        <Loading className="text-muted-foreground in-[button]:text-muted-foreground size-3 shrink-0" />
      ) : status === 'done' ? (
        <CheckIcon aria-hidden className="text-kortix-green size-3 shrink-0" />
      ) : status === 'failed' ? (
        <WarningIcon weight="fill" aria-hidden className="text-kortix-red size-3 shrink-0" />
      ) : status === 'pending' ? (
        <CircleDashedIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
      ) : (
        <MinusIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
      )}
      <span className="sr-only">{label}</span>
    </>
  );
}

/** The script's newest `log()` lines, muted, above the phases. */
export function WorkflowLogs({ logs }: { logs: string[] }) {
  const t = useTranslations('tools.workflow');
  const indent = useToolIndent();
  if (logs.length === 0) return null;
  return (
    <ol
      aria-label={t('logLabel')}
      className={cn('text-muted-foreground space-y-0.5 text-xs text-pretty wrap-anywhere', indent && 'mt-1.5', indent)}
    >
      {logs.map((line, index) => (
        // Lines repeat and carry no id; the list is the newest 5, replaced whole.
        <li key={`${index}:${line}`}>{line}</li>
      ))}
    </ol>
  );
}

export interface AgentStopState {
  /** Whether a row's agent can be stopped from here at all (a project, a live run). */
  enabled: boolean;
  /** Session ids whose stop is in flight. */
  pending: ReadonlySet<string>;
  stop: (agent: WorkflowRunAgent) => void;
  /** Claude Code's `r`: stop a running agent and start it again with the same prompt. Absent: no Restart. */
  restart?: {
    /** The agent session whose restart is in flight. */
    pending?: string;
    run: (agent: WorkflowRunAgent) => void;
  };
}

export function WorkflowProgress({
  run,
  live,
  now,
  onOpen,
  stop,
}: {
  run: WorkflowRun;
  /** The run is under way in this call: elapsed time ticks and running rows can be stopped. */
  live: boolean;
  now: number;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
}) {
  const t = useTranslations('tools.workflow');
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [uncapped, setUncapped] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(() => groupAgents(run), [run]);
  const counts = useMemo(() => countAgents(run.agents), [run.agents]);
  const showFilter = run.agents.length > FILTER_FROM;
  const active = showFilter ? filter : 'all';
  // The elapsed column exists only when some agent reports when it started.
  const timed = run.agents.some((agent) => agent.startedAt !== undefined);

  const toggle = useCallback(
    (setter: typeof setCollapsed, key: string) =>
      setter((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  const cycleFilter = useCallback((step: 1 | -1) => {
    setFilter((current) => {
      const index = AGENT_FILTERS.indexOf(current);
      return AGENT_FILTERS[(index + step + AGENT_FILTERS.length) % AGENT_FILTERS.length]!;
    });
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-workflow-row]'));
        const index = rows.indexOf(target.closest<HTMLElement>('[data-workflow-row]') as HTMLElement);
        if (index === -1) return;
        const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        next.focus();
      } else if ((event.key === 'f' || event.key === 'F') && showFilter) {
        event.preventDefault();
        cycleFilter(event.shiftKey ? -1 : 1);
      }
    },
    [showFilter, cycleFilter],
  );

  const visible = groups
    .map((group) => ({ group, agents: group.agents.filter((agent) => agentMatches(agent, active)) }))
    // Under a filter, a group with no matching agent (a pending phase included) is left out.
    .filter(({ agents }) => active === 'all' || agents.length > 0);
  const nothing = active !== 'all' && visible.every(({ agents }) => agents.length === 0);
  if (groups.length === 0) return null;

  return (
    <div role="group" aria-label={t('agentsLabel')} onKeyDown={onKeyDown}>
      {showFilter && (
        <FilterBar filter={active} counts={counts} onChange={setFilter} />
      )}
      <ToolResultCard bodyClassName="py-0.5">
        {nothing ? (
          <p className="text-muted-foreground px-2 py-1 text-xs">{t(`filterEmpty.${active as Exclude<AgentFilter, 'all'>}`)}</p>
        ) : (
          <ul>
            {visible.map(({ group, agents }) => {
              const key = group.phase?.title ?? '';
              const rows = (
                <AgentRows
                  agents={agents}
                  capped={agents.length > CAP_FROM && !uncapped.has(key)}
                  onShowAll={() => toggle(setUncapped, key)}
                  live={live}
                  now={now}
                  timed={timed}
                  onOpen={onOpen}
                  stop={stop}
                />
              );
              if (!group.phase) return <li key="loose">{rows}</li>;
              const open = !collapsed.has(key);
              return (
                <li key={`phase:${key}`}>
                  <PhaseHeader
                    group={group}
                    shown={agents.length}
                    filtered={active !== 'all'}
                    open={open}
                    onToggle={() => toggle(setCollapsed, key)}
                  />
                  {open && agents.length > 0 && <div className="pl-5">{rows}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </ToolResultCard>
    </div>
  );
}

function FilterBar({
  filter,
  counts,
  onChange,
}: {
  filter: AgentFilter;
  counts: ReturnType<typeof countAgents>;
  onChange: (filter: AgentFilter) => void;
}) {
  const t = useTranslations('tools.workflow');
  const indent = useToolIndent();
  const tally: Record<AgentFilter, number> = {
    all: counts.total,
    running: counts.running,
    failed: counts.failed,
    done: counts.done,
  };
  return (
    <Tabs value={filter} onValueChange={(value) => onChange(value as AgentFilter)} className={cn(indent && 'mt-1.5', indent)}>
      <TabsListCompact aria-label={t('filter.label')}>
        {AGENT_FILTERS.map((value) => (
          <TabsTriggerCompact key={value} value={value} className="gap-1.5">
            {t(`filter.${value}`)}
            <CountBadge count={tally[value]} />
          </TabsTriggerCompact>
        ))}
      </TabsListCompact>
    </Tabs>
  );
}

function PhaseHeader({
  group,
  shown,
  filtered,
  open,
  onToggle,
}: {
  group: AgentGroup;
  shown: number;
  filtered: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('tools.workflow');
  const phase = group.phase!;
  const pending = phase.status === 'pending';
  const tally = countAgents(group.agents);
  const detail = pending
    ? t('status.pending')
    : group.agents.length === 0
      ? undefined
      : filtered
        ? t('agents', { count: shown })
        : [
            phase.status === 'running' ? t('progress', { done: tally.done, total: tally.total }) : t('agents', { count: tally.total }),
            tally.failed > 0 ? t('failedSuffix', { count: tally.failed }) : undefined,
          ]
            .filter(Boolean)
            .join(' · ');
  const body = (
    <>
      <StateMark status={phase.status} label={t(`status.${phase.status}`)} />
      <span className={cn('min-w-0 truncate font-medium', pending ? 'text-muted-foreground' : 'text-foreground')} title={phase.title}>
        {phase.title}
      </span>
      {detail && <span className="text-muted-foreground shrink-0 tabular-nums">{detail}</span>}
    </>
  );
  const rowClass = 'flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs';
  // A phase with no rows has nothing to fold: a plain line, not a control.
  if (group.agents.length === 0) return <div className={rowClass}>{body}</div>;
  return (
    <button
      type="button"
      data-workflow-row
      aria-expanded={open}
      onClick={onToggle}
      className={cn(rowClass, 'hover:bg-muted/40 cursor-pointer')}
    >
      {body}
      <CaretRightIcon
        aria-hidden
        className={cn('text-muted-foreground ml-auto size-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
      />
    </button>
  );
}

function AgentRows({
  agents,
  capped,
  onShowAll,
  ...row
}: {
  agents: WorkflowRunAgent[];
  capped: boolean;
  onShowAll: () => void;
  live: boolean;
  now: number;
  timed: boolean;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
}) {
  const t = useTranslations('tools.workflow');
  const shown = capped ? agents.slice(0, GROUP_CAP) : agents;
  return (
    <ul>
      {shown.map((agent) => (
        <AgentRow key={agent.id} agent={agent} {...row} />
      ))}
      {capped && (
        <li>
          <button
            type="button"
            data-workflow-row
            onClick={onShowAll}
            className="text-muted-foreground hover:text-foreground w-full cursor-pointer rounded-sm px-2 py-1 text-left text-xs"
          >
            {t('showAll', { count: agents.length })}
          </button>
        </li>
      )}
    </ul>
  );
}

/** `kortix/claude-sonnet-4.6` reads `claude-sonnet-4.6`; the row's title keeps the whole id. */
function shortModel(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1) || model;
}

function AgentRow({
  agent,
  live,
  now,
  timed,
  onOpen,
  stop,
}: {
  agent: WorkflowRunAgent;
  live: boolean;
  now: number;
  timed: boolean;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
}) {
  const t = useTranslations('tools.workflow');
  const tm = useTranslations('multiAgent.workflow');
  const describedBy = useId();
  const [jsonOpen, setJsonOpen] = useState(false);
  const statusLabel = t(`status.${agent.status}`);
  const working = agent.status === 'starting' || agent.status === 'running';
  const structured = agent.structured && agent.summary ? structuredSummary(agent.summary) : undefined;
  const meta = [
    agent.agent,
    agent.model ? shortModel(agent.model) : undefined,
    agent.attempt && agent.attempt > 1 ? t('retry', { count: agent.attempt - 1 }) : undefined,
    agent.cached ? t('cached') : undefined,
  ].filter((part): part is string => !!part);
  const elapsed = elapsedMs(agent, live && working, now);
  const summary = agent.summary ?? (agent.status === 'running' ? '' : statusLabel);

  const head = (
    <>
      <StateMark status={agent.status} label={statusLabel} />
      <span className="text-foreground min-w-0 shrink truncate" title={agent.label}>
        {agent.label}
      </span>
      {meta.length > 0 && (
        <span className="text-muted-foreground max-w-[40%] shrink-0 truncate" title={agent.model ? [agent.agent, agent.model].filter(Boolean).join(' · ') : undefined}>
          {meta.join(' · ')}
        </span>
      )}
      <span id={describedBy} className="text-muted-foreground min-w-0 flex-1 truncate" title={structured ? undefined : agent.summary}>
        {structured ? <span className="sr-only">{statusLabel}</span> : summary}
      </span>
    </>
  );
  const headClass = 'flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left';
  const canStop = stop.enabled && live && working && !!agent.sessionId;
  const stopping = !!agent.sessionId && stop.pending.has(agent.sessionId);

  return (
    <li>
      <div className={cn('flex min-w-0 items-center gap-1 rounded-sm text-xs', agent.sessionId && 'hover:bg-muted/40')}>
        {agent.sessionId ? (
          <button
            type="button"
            data-workflow-row
            aria-label={t('openAgent', { label: agent.label })}
            aria-describedby={describedBy}
            onClick={() => onOpen(agent)}
            className={cn(headClass, 'cursor-pointer')}
          >
            {head}
          </button>
        ) : (
          <div className={headClass}>{head}</div>
        )}
        {structured && (
          <button
            type="button"
            data-workflow-row
            aria-expanded={jsonOpen}
            onClick={() => setJsonOpen((open) => !open)}
            className="text-muted-foreground hover:text-foreground flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-1 tabular-nums"
          >
            {structured.kind === 'object'
              ? t('jsonKeys', { count: structured.keys })
              : structured.kind === 'array'
                ? t('jsonItems', { count: structured.items })
                : t('json')}
            <CaretRightIcon
              aria-hidden
              className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', jsonOpen && 'rotate-90')}
            />
          </button>
        )}
        {timed && (
          <span className="text-muted-foreground min-w-12 shrink-0 pr-1 text-right tabular-nums">
            {elapsed !== undefined ? formatElapsed(elapsed) : ''}
          </span>
        )}
        {/* Restart sits before Stop, in its own fixed slot, for the same reason. */}
        {live && stop.enabled && stop.restart && (
          <span className="flex size-6 shrink-0 items-center justify-center">
            {stop.restart.pending && stop.restart.pending === agent.sessionId ? (
              <Loading className="text-muted-foreground size-3" />
            ) : canStop && !stopping ? (
              <Hint label={tm('restartHint')} side="top" sideOffset={4} alignOffset={0}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={tm('restartAgent', { label: agent.label })}
                  onClick={() => stop.restart?.run(agent)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ArrowClockwiseIcon className="size-3" />
                </Button>
              </Hint>
            ) : null}
          </span>
        )}
        {/* While the run is live every row keeps the Stop slot, so a row that finishes does not shift its neighbours' columns. */}
        {live && stop.enabled && (
          <span className="flex size-6 shrink-0 items-center justify-center">
            {stopping && working ? (
              <Loading className="text-muted-foreground size-3" />
            ) : canStop ? (
              <Hint label={t('stopHint')} side="top" sideOffset={4} alignOffset={0}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('stopAgent', { label: agent.label })}
                  onClick={() => stop.stop(agent)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <SquareIcon weight="fill" className="size-2.5" />
                </Button>
              </Hint>
            ) : null}
          </span>
        )}
      </div>
      {structured && jsonOpen && (
        <div className="pr-1 pb-1 pl-7">
          <OutputBlock text={structured.pretty} />
        </div>
      )}
    </li>
  );
}
