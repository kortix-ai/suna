'use client';

import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowClockwiseIcon, CaretDownIcon, CaretRightIcon, SquareIcon } from '@phosphor-icons/react';
import { Button } from '../../../primitives/button';
import { Hint } from '../../../primitives/hint';

import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { SessionStatusMark } from '../../list/session-status-mark';
import { runGlyphStatus } from '../../agents/agent-state-mark';
import { RunProgressRing, type AgentStopState } from './workflow-progress';
import {
  countAgents,
  elapsedMs,
  formatElapsed,
  type WorkflowAgentStatus,
  type WorkflowRun,
  type WorkflowRunAgent,
} from './workflow-run';

/**
 * The workflow run card in the chat (Paper C19). One card, never a fold:
 *
 *   ◔  Kortix growth marketing deep dive          Pause  Stop  Open run
 *      Research 2 of 5 done · 6:10
 *   ─────────────────────────────────────────────────────────────────
 *   ●  Acquisition and public footprint          Didn’t finish · Retry
 *   ◠  Audience and demand                                     6:08  ↻ ■
 *   ✺  Product and positioning                                   4:51
 *   ○  Strategy synthesis                            Waits for 3 more
 *
 * The ring and the second line say the progress once. Rows are flat, sorted by
 * what needs the person first (failed, then working, then done), with the
 * phases that have not started as one muted row each. A row opens its agent in
 * the agent dialog; a running row keeps Restart and Stop beside it.
 */

/** Failed first: it waits on a decision. Then the work in flight, then the finished. */
const ORDER: Record<WorkflowAgentStatus, number> = { failed: 0, running: 1, starting: 2, stopped: 3, done: 4 };
/** A run longer than this lists its first rows and a "Show all". */
const CAP_FROM = 25;
const CAP = 20;

export function WorkflowRunCard({
  run,
  title,
  subtitle,
  live,
  now,
  actions,
  chips,
  result,
  onOpen,
  stop,
}: {
  run: WorkflowRun;
  title: string;
  subtitle?: string;
  live: boolean;
  now: number;
  /** The header's words on the right: Pause, Stop, Open run. */
  actions?: ReactNode;
  /** Warnings beside the title: "Large workflow", "Resumed". */
  chips?: ReactNode;
  /** The run's result: a "Result" toggle at the header's right opens it inside the card, under the header. */
  result?: ReactNode;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
}) {
  const t = useTranslations('tools.workflow');
  const [showResult, setShowResult] = useState(false);
  const resultId = useId();
  const counts = countAgents(run.agents);

  return (
    <section
      data-testid="workflow-card"
      aria-label={title}
      // Flush with the reply's text column: the card is the turn's content, not a tool row's body.
      className="border-border mt-1.5 flex min-w-0 flex-col rounded-lg border text-xs"
    >
      {/* One left edge for the header and the rows (px-4); the ring sits in the rows' 16px glyph lane. */}
      <header className="border-border flex min-w-0 items-start gap-2.5 border-b px-4 py-3">
        <span className="flex h-5 shrink-0 items-center">
          {counts.total > 0 ? (
            <RunProgressRing
              size={16}
              done={counts.done}
              failed={counts.failed}
              total={counts.total}
              ended={run.status === 'done' ? 'done' : run.status === 'stopped' ? 'stopped' : undefined}
            />
          ) : (
            <SessionStatusMark status={runGlyphStatus(run.status === 'running' ? 'starting' : run.status)} />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="text-foreground min-w-0 truncate text-sm font-medium" title={title}>
              {title}
            </h3>
            {chips}
          </div>
          {subtitle && (
            <p className="text-muted-foreground min-w-0 truncate tabular-nums" title={subtitle}>
              {subtitle}
            </p>
          )}
        </div>
        {(actions || result) && (
          <div className="-my-1 flex shrink-0 items-center">
            {actions}
            {result && (
              <button
                type="button"
                aria-expanded={showResult}
                aria-controls={resultId}
                onClick={() => setShowResult((open) => !open)}
                className="text-foreground hover:bg-muted/60 flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs"
              >
                {t('result')}
                <CaretDownIcon
                  aria-hidden
                  className={cn('size-3 transition-transform duration-(--duration-fast) motion-reduce:transition-none', showResult && 'rotate-180')}
                />
              </button>
            )}
          </div>
        )}
      </header>
      {result && showResult && (
        <div id={resultId} className="border-border max-h-96 overflow-y-auto border-b px-4 py-3 text-sm">
          {result}
        </div>
      )}
      {/* Never a fold: running or ended, the rows are the record of who did what. */}
      <WorkflowRunRows run={run} live={live} now={now} onOpen={onOpen} stop={stop} />
    </section>
  );
}

/**
 * A run's agents under their phases. Each phase is one row: its progress ring
 * (done and failed agents of that phase), its name and "2 of 7 done", and on
 * the right why it waits or how many failed. A phase opens in place onto its
 * agents, nested on a trunk with rounded elbows (the session list's recipe), so
 * the card stays short: every phase starts closed. A run with no phases lists
 * its agents flat. The card draws it, and so does the agents line's run row.
 */
export function WorkflowRunRows({
  run,
  live,
  now,
  onOpen,
  stop,
  openPhases,
}: {
  run: WorkflowRun;
  live: boolean;
  now: number;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
  /** Phases that start open; every other phase starts closed. */
  openPhases?: readonly string[];
}) {
  const t = useTranslations('tools.workflow');
  const groups = groupRows(run);
  const unfinished = run.agents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length;
  return (
    <div onKeyDown={moveBetweenRows} className="flex flex-col p-1.5">
      {groups.map((group, index) => {
        if (!group.phase) {
          return (
            <CappedAgentList key="loose" agents={group.agents} live={live} now={now} onOpen={onOpen} stop={stop} />
          );
        }
        const after = groups[index - 1]?.phase?.title;
        // One phrase for why a phase has not started: the agents it waits on, else the phase before it.
        const waits =
          group.agents.length === 0 && group.phase.status === 'pending'
            ? unfinished > 0
              ? t('waitsFor', { count: unfinished })
              : after
                ? t('startsAfter', { phase: after })
                : null
            : null;
        return (
          <PhaseRow
            key={`phase:${group.phase.title}`}
            phase={group.phase}
            agents={group.agents}
            waits={waits}
            defaultOpen={openPhases?.includes(group.phase.title) ?? false}
            live={live}
            now={now}
            onOpen={onOpen}
            stop={stop}
          />
        );
      })}
    </div>
  );
}

/** One phase: a row with its ring that opens onto its agents, nested on the trunk. */
function PhaseRow({
  phase,
  agents,
  waits,
  defaultOpen,
  live,
  now,
  onOpen,
  stop,
}: {
  phase: WorkflowRun['phases'][number];
  agents: WorkflowRunAgent[];
  waits: string | null;
  defaultOpen: boolean;
  live: boolean;
  now: number;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
}) {
  const t = useTranslations('tools.workflow');
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const tally = countAgents(agents);
  const opens = agents.length > 0;
  const pending = !opens && phase.status === 'pending';
  // A closed phase still says it is at work: "4 running · 1 failed".
  const running = agents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length;
  const meta =
    waits ??
    ([running > 0 ? t('runningCount', { count: running }) : null, tally.failed > 0 ? t('failedSuffix', { count: tally.failed }) : null]
      .filter(Boolean)
      .join(' · ') ||
      null);
  const row = (
    <>
      <RunProgressRing
        done={tally.done}
        failed={tally.failed}
        total={tally.total}
        ended={phase.status === 'done' && tally.total > 0 && tally.done === tally.total ? 'done' : phase.status === 'stopped' ? 'stopped' : undefined}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cn('min-w-0 truncate text-sm', pending ? 'text-muted-foreground' : 'text-foreground')}>{phase.title}</span>
        {opens && <span className="text-muted-foreground shrink-0 tabular-nums">{t('progress', { done: tally.done, total: tally.total })}</span>}
      </span>
      {/* The caret's column (size-3 + gap-2 = pr-5) is reserved, so this text ends where the agent rows' does. */}
      <span className="flex shrink-0 items-center gap-2">
        {meta && <span className="text-muted-foreground">{meta}</span>}
        <CaretRightIcon
          aria-hidden
          className={cn(
            'text-muted-foreground size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
            !opens && 'invisible',
            open && 'rotate-90',
          )}
        />
      </span>
    </>
  );
  // px-2.5 puts the ring on the header's and the agent rows' left edge; the trunk hangs from its
  // centre: ml-4 pl-0.5 = px-2.5 + half of the size-4 ring.
  const rowClass = 'flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left';
  return (
    <section aria-label={phase.title} data-workflow-phase={phase.title} className="flex flex-col">
      {opens ? (
        <button
          type="button"
          data-workflow-row
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className={cn(rowClass, 'hover:bg-muted/40 cursor-pointer transition-colors')}
        >
          {row}
        </button>
      ) : (
        <div className={rowClass}>{row}</div>
      )}
      {opens && open && (
        <div id={bodyId} className="ml-4 pr-5 pl-0.5">
          <CappedAgentList agents={agents} live={live} now={now} onOpen={onOpen} stop={stop} nested />
        </div>
      )}
    </section>
  );
}

/** A list of agent rows; past 25 it shows the first 20 and "Show all". Nested, each row hangs off the trunk. */
function CappedAgentList({
  agents,
  live,
  now,
  onOpen,
  stop,
  nested = false,
}: {
  agents: WorkflowRunAgent[];
  live: boolean;
  now: number;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
  nested?: boolean;
}) {
  const t = useTranslations('tools.workflow');
  const [all, setAll] = useState(false);
  const capped = agents.length > CAP_FROM && !all;
  const rows = capped ? agents.slice(0, CAP) : agents;
  return (
    <ul role="list" className="flex flex-col">
      {rows.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          live={live}
          now={now}
          onOpen={onOpen}
          stop={stop}
          // The trunk ends at the last agent row; "Show all" hangs under it, not on it.
          trunk={nested ? { continues: index < rows.length - 1 } : undefined}
        />
      ))}
      {capped && (
        <li className={cn(nested && 'pl-3.5')}>
          <button
            type="button"
            data-workflow-row
            onClick={() => setAll(true)}
            className="text-muted-foreground hover:text-foreground flex h-9 w-full cursor-pointer items-center rounded-md px-2.5 text-left"
          >
            {t('showAll', { count: agents.length })}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * The trunk beside one nested row (the session list's `ChildRunBranch`): a row
 * with siblings below carries the trunk through its height; the last one ends
 * at its own rounded elbow, which meets the row's first line.
 */
function TrunkLines({ continues }: { continues: boolean }) {
  return (
    <>
      {continues && <span aria-hidden className="border-border pointer-events-none absolute top-0 -bottom-px left-0 border-l-2" />}
      {/* Whole-pixel geometry: the elbow meets the row's first line at py-2 (7.36px) + half its 20px line = 17px. */}
      <span aria-hidden className="border-border pointer-events-none absolute top-0 left-0 h-[17px] w-3.5 rounded-bl-md border-b-2 border-l-2" />
    </>
  );
}

type RowGroup = { phase: WorkflowRun['phases'][number] | null; agents: WorkflowRunAgent[] };

/** Agents under their phase, in phase order, each phase's rows sorted by state. Agents of no phase come first. */
function groupRows(run: WorkflowRun): RowGroup[] {
  const sort = (agents: WorkflowRunAgent[]) =>
    agents
      .map((agent, index) => ({ agent, index }))
      .sort((a, b) => ORDER[a.agent.status] - ORDER[b.agent.status] || a.index - b.index)
      .map(({ agent }) => agent);
  const known = new Set(run.phases.map((phase) => phase.title));
  const loose = run.agents.filter((agent) => !agent.phase || !known.has(agent.phase));
  const groups: RowGroup[] = loose.length > 0 ? [{ phase: null, agents: sort(loose) }] : [];
  for (const phase of run.phases) groups.push({ phase, agents: sort(run.agents.filter((agent) => agent.phase === phase.title)) });
  return groups;
}

/** ↑ and ↓ move between the rows, as in Claude Code's `/workflows`. Enter opens the focused agent (a button). */
function moveBetweenRows(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-workflow-row]'));
  const index = rows.indexOf((event.target as HTMLElement).closest<HTMLElement>('[data-workflow-row]') as HTMLElement);
  const next = index === -1 ? undefined : rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function AgentRow({
  agent,
  live,
  now,
  onOpen,
  stop,
  trunk,
}: {
  agent: WorkflowRunAgent;
  live: boolean;
  now: number;
  onOpen: (agent: WorkflowRunAgent) => void;
  stop: AgentStopState;
  /** Nested under a phase: the row hangs off the trunk; `continues` carries it on to the next row. */
  trunk?: { continues: boolean };
}) {
  const t = useTranslations('tools.workflow');
  const working = agent.status === 'running' || agent.status === 'starting';
  const elapsed = elapsedMs(agent, live && working, now);
  const state =
    agent.status === 'failed'
      ? t('didntFinish')
      : agent.status === 'starting'
        ? t('status.starting')
        : agent.status === 'stopped'
          ? t('status.stopped')
          : null;
  // Working and finished rows are one line: status, name, time. Only a failure says why.
  const detail = agent.status === 'failed' ? (agent.summary ?? null) : null;
  const canRetry = agent.status === 'failed' && live && !!agent.sessionId && !!stop.restart;
  const retrying = !!agent.sessionId && stop.restart?.pending === agent.sessionId;
  const stopping = !!agent.sessionId && stop.pending.has(agent.sessionId);
  const tm = useTranslations('multiAgent.workflow');

  const body = (
    <>
      {/* On the title's line (h-5 = its 18.4px), so a failure's reason below never pulls the glyph off the trunk's elbow. */}
      <span className="flex h-5 shrink-0 items-center">
        <SessionStatusMark status={runGlyphStatus(agent.status)} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className={cn('text-foreground min-w-0 flex-1 truncate text-sm', agent.status !== 'done' && 'font-medium')} title={agent.label}>
            {agent.label}
          </span>
          {state && <span className="text-muted-foreground shrink-0">{state}</span>}
          {elapsed !== undefined && agent.status !== 'failed' && (
            <span className="text-muted-foreground min-w-9 shrink-0 text-right tabular-nums">{formatElapsed(elapsed)}</span>
          )}
        </span>
        {detail && (
          <span className="text-muted-foreground min-w-0 whitespace-normal wrap-anywhere">
            {detail}
          </span>
        )}
      </span>
    </>
  );

  const rowClass = cn(
    'flex min-h-9 min-w-0 flex-1 items-start gap-2.5 rounded-md px-2.5 py-2',
    agent.sessionId && 'hover:bg-muted/40',
  );

  return (
    <li className={cn('relative flex min-w-0 items-start', trunk && 'pl-3.5')}>
      {trunk && <TrunkLines continues={trunk.continues} />}
      {agent.sessionId ? (
        <button
          type="button"
          data-workflow-row
          aria-label={[t('openAgent', { label: agent.label }), state ?? t(`status.${agent.status === 'done' ? 'done' : agent.status === 'running' ? 'running' : 'starting'}`), elapsed !== undefined && agent.status !== 'failed' ? formatElapsed(elapsed) : null].filter(Boolean).join(', ')}
          onClick={() => onOpen(agent)}
          className={cn(rowClass, 'cursor-pointer')}
        >
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {/* A running agent keeps Restart and Stop beside its row (Claude Code's `r` and `x`): the row opens it. */}
      {live && working && !!agent.sessionId && stop.enabled && (
        <span className="flex shrink-0 items-center py-1.5">
          {stop.restart && (
            <Hint label={tm('restartHint')} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={tm('restartAgent', { label: agent.label })}
                disabled={retrying || stopping}
                aria-busy={retrying}
                onClick={() => stop.restart?.run(agent)}
                className="text-muted-foreground hover:text-foreground"
              >
                <ArrowClockwiseIcon className="size-3" />
              </Button>
            </Hint>
          )}
          <Hint label={t('stopHint')} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('stopAgent', { label: agent.label })}
              disabled={stopping}
              aria-busy={stopping}
              onClick={() => stop.stop(agent)}
              className="text-muted-foreground hover:text-foreground"
            >
              <SquareIcon weight="fill" className="size-2.5" />
            </Button>
          </Hint>
        </span>
      )}
      {canRetry && (
        <button
          type="button"
          aria-label={t('retryAgent', { label: agent.label })}
          disabled={retrying}
          onClick={() => stop.restart?.run(agent)}
          className="text-foreground hover:bg-muted/60 my-1 flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2 disabled:opacity-50"
        >
          {t('retryNow')}
        </button>
      )}
    </li>
  );
}
