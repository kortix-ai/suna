/**
 * `/agents` and `/workflows`: the agents the open session started, above the
 * input like the other command panels (`commands/panels.tsx`).
 *
 *   ╭ Agents · 3 ─────────────────────────────────────────────╮
 *   │ Needs you · 1                                           │
 *   │▌? reviewer                               Has a question │
 *   │ Working · 1                                             │
 *   │  ● coder · Editing auth.ts                   working · 4m│
 *   │ Workflows · 1                                           │
 *   │  ▸ Audit the repo              3 of 8 done · 1 running  │
 *   ╰──────────────────────── Enter peek · o open · x stop · Esc ╯
 *
 * Peek, then switch: Enter draws a live read-only view of that agent's session
 * over the transcript (`useAgentNav().peek`), `o` opens it as the main
 * session (`switchTo`). `x` stops an agent or a run, `p` pauses or resumes a
 * run, `r` restarts a failed agent of a running run, `a`/`d` decide a held
 * message. The bottom title names only the keys the selected row answers.
 *
 * `AgentsPanelView` is the pure view (tests drive it with fixture rows);
 * `AgentsPanel` reads `useSessionAgents` and the nav.
 */

import type {
  PeerMessage,
  SessionBoardState,
  WorkflowControlBody,
  WorkflowRunAgent,
} from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useState } from 'react';

import { printable } from '../../lib/printable.ts';
import { relativeAge } from '../../lib/relative-time.ts';
import { theme } from '../../theme.ts';
import { layoutRow, windowStart } from '../../ui/index.ts';
import { type PeekTarget, useAgentNav } from './agent-nav.tsx';
import {
  type AgentGroups,
  type AgentRow,
  type PanelRow,
  type PanelScope,
  type RunRow,
  allAgents,
  isActive,
  isChoice,
  panelRows,
  runProgress,
} from './agents-model.ts';
import { matchesAgentsBinding } from './keys.ts';
import { type Notice, type StopTarget, useSessionAgents } from './use-session-agents.ts';

export interface AgentsPanelViewProps {
  groups: AgentGroups;
  runs: readonly RunRow[];
  held: readonly PeerMessage[];
  only: PanelScope;
  loading: boolean;
  notice: Notice | null;
  width: number;
  now: number;
  /** Visible rows. 9 + the border + the notice line fit `PICKER_RESERVE_ROWS` (12). */
  maxRows?: number;
  onPeek(target: PeekTarget): void;
  onOpen(sessionId: string): void;
  onStop(target: StopTarget): void;
  onControl(run: RunRow, body: WorkflowControlBody): void;
  onApprove(messageId: string): void;
  onDeny(messageId: string): void;
  onClose(): void;
}

/** `12s`, `4m`, `2h`. */
export function shortElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

const AGENT_GLYPH: Record<SessionBoardState, { glyph: string; color: string }> = {
  needs_input: { glyph: '?', color: theme.accent },
  working: { glyph: '●', color: theme.busy },
  idle: { glyph: '✓', color: theme.ok },
  completed: { glyph: '✓', color: theme.ok },
  failed: { glyph: '!', color: theme.danger },
  stopped: { glyph: '○', color: theme.faint },
};

const RUN_AGENT_GLYPH: Record<WorkflowRunAgent['status'], { glyph: string; color: string }> = {
  starting: { glyph: '○', color: theme.busy },
  running: { glyph: '●', color: theme.busy },
  done: { glyph: '✓', color: theme.ok },
  failed: { glyph: '!', color: theme.danger },
  stopped: { glyph: '○', color: theme.faint },
};

function agentState(row: AgentRow, now: number): string {
  switch (row.state) {
    case 'needs_input':
      return row.attention === 'question'
        ? 'Has a question'
        : row.attention === 'approval'
          ? 'Waits for your approval'
          : 'Needs you';
    case 'working':
      return row.workingSinceMs !== null
        ? `working · ${shortElapsed(now - row.workingSinceMs)}`
        : 'working';
    case 'failed':
      return "Didn't finish";
    case 'stopped':
      return 'Stopped';
    default:
      return row.activityMs > 0 ? `done · ${relativeAge(row.activityMs, now)}` : 'done';
  }
}

function runState(run: RunRow): string {
  const progress = runProgress(run);
  if (run.status === 'running') return run.paused ? `Paused · ${progress}` : progress;
  if (run.status === 'failed') return `Didn't finish · ${progress}`;
  if (run.status === 'stopped') return `Stopped · ${progress}`;
  return progress;
}

function runAgentState(agent: WorkflowRunAgent, now: number): string {
  switch (agent.status) {
    case 'running':
      return agent.startedAt ? `running · ${shortElapsed(now - agent.startedAt)}` : 'running';
    case 'starting':
      return 'Starting';
    case 'done':
      return 'Done';
    case 'failed':
      return "Didn't finish";
    default:
      return 'Stopped';
  }
}

/** A failed or stopped agent of a running run, with its session: `r` restarts it. */
function canRestart(row: Extract<PanelRow, { kind: 'run-agent' }>): boolean {
  return (
    row.run.status === 'running' &&
    Boolean(row.agent.sessionId) &&
    (row.agent.status === 'failed' || row.agent.status === 'stopped')
  );
}

/** A workflow agent that runs, with its session: `x` stops it. */
function canStopRunAgent(row: Extract<PanelRow, { kind: 'run-agent' }>): boolean {
  return (
    Boolean(row.agent.sessionId) &&
    (row.agent.status === 'running' || row.agent.status === 'starting')
  );
}

/** The keys the selected row answers, for the bottom title. */
export function panelHint(row: PanelRow | undefined): string {
  if (!row || !isChoice(row)) return 'Esc close';
  if (row.kind === 'agent')
    return isActive(row.agent.state)
      ? 'Enter peek · o open · x stop · Esc close'
      : 'Enter peek · o open · Esc close';
  if (row.kind === 'run') {
    const fold = row.expanded ? 'Enter collapse' : 'Enter expand';
    return row.run.status === 'running'
      ? `${fold} · p ${row.run.paused ? 'resume' : 'pause'} · x stop · Esc close`
      : `${fold} · Esc close`;
  }
  if (row.kind === 'run-agent') {
    if (!row.agent.sessionId) return 'Esc close';
    const keys = ['Enter peek', 'o open'];
    if (canRestart(row)) keys.push('r restart');
    if (canStopRunAgent(row)) keys.push('x stop');
    return [...keys, 'Esc close'].join(' · ');
  }
  return 'a approve · d deny · Enter peek · Esc close';
}

/** The session a row stands for, for Enter and `o`. */
function rowTarget(row: PanelRow | undefined): PeekTarget | null {
  if (!row) return null;
  if (row.kind === 'agent') return { sessionId: row.agent.sessionId, title: row.agent.handle };
  if (row.kind === 'run-agent' && row.agent.sessionId)
    return { sessionId: row.agent.sessionId, title: row.agent.label };
  if (row.kind === 'held')
    return { sessionId: row.message.from_session_id, title: row.message.from_handle };
  return null;
}

function nextChoice(rows: readonly PanelRow[], from: number, step: 1 | -1): number {
  for (let index = from; index >= 0 && index < rows.length; index += step) {
    if (isChoice(rows[index])) return index;
  }
  return -1;
}

export function AgentsPanelView({
  groups,
  runs,
  held,
  only,
  loading,
  notice,
  width,
  now,
  maxRows = 9,
  onPeek,
  onOpen,
  onStop,
  onControl,
  onApprove,
  onDeny,
  onClose,
}: AgentsPanelViewProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () => panelRows({ groups, runs, held, expanded, only }),
    [groups, runs, held, expanded, only],
  );
  // Selection follows the row's id, so a poll that reorders rows keeps it. A
  // row that left the list hands the selection to the first choice.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const found = selectedId ? rows.findIndex((row) => row.id === selectedId) : -1;
  const index = found >= 0 ? found : nextChoice(rows, 0, 1);
  const selected = index >= 0 ? rows[index] : undefined;

  const move = (step: 1 | -1) => {
    const next = nextChoice(rows, index + step, step);
    if (next >= 0) setSelectedId(rows[next]?.id ?? null);
  };

  const toggle = (runId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });

  useKeyboard((key) => {
    const is = (id: string) => matchesAgentsBinding(key, id);
    if (is('close')) {
      key.preventDefault();
      return onClose();
    }
    if (is('up') || is('down')) {
      key.preventDefault();
      return move(is('up') ? -1 : 1);
    }
    if (!selected || !isChoice(selected)) return;
    if (selected.kind === 'run' && (is('peek') || is('fold'))) {
      key.preventDefault();
      if (key.name === 'right' && selected.expanded) return;
      if (key.name === 'left' && !selected.expanded) return;
      return toggle(selected.run.runId);
    }
    if (is('peek') || is('open')) {
      key.preventDefault();
      const target = rowTarget(selected);
      if (!target) return;
      if (is('peek')) onPeek(target);
      else onOpen(target.sessionId);
      return;
    }
    if (is('stop')) {
      key.preventDefault();
      if (selected.kind === 'agent' && isActive(selected.agent.state))
        onStop({ sessionId: selected.agent.sessionId, title: selected.agent.handle });
      else if (selected.kind === 'run' && selected.run.status === 'running')
        onControl(selected.run, { action: 'stop' });
      else if (
        selected.kind === 'run-agent' &&
        canStopRunAgent(selected) &&
        selected.agent.sessionId
      )
        onStop({ sessionId: selected.agent.sessionId, title: selected.agent.label });
      return;
    }
    if (is('pause')) {
      key.preventDefault();
      const run = selected.kind === 'run' || selected.kind === 'run-agent' ? selected.run : null;
      if (run && run.status === 'running')
        onControl(run, { action: run.paused ? 'resume' : 'pause' });
      return;
    }
    if (is('restart')) {
      key.preventDefault();
      if (selected.kind === 'run-agent' && canRestart(selected) && selected.agent.sessionId)
        onControl(selected.run, { action: 'restart_agent', session_id: selected.agent.sessionId });
      return;
    }
    if (selected.kind === 'held' && (is('approve') || is('deny'))) {
      key.preventDefault();
      if (is('approve')) onApprove(selected.message.id);
      else onDeny(selected.message.id);
    }
  });

  const inner = Math.max(width - 4, 10);
  const visibleRows = Math.max(Math.min(maxRows, rows.length), 1);
  const start = windowStart(Math.max(index, 0), rows.length, visibleRows);
  const visible = rows.slice(start, start + visibleRows);
  const agentCount = allAgents(groups).length;
  const title =
    only === 'workflows'
      ? loading
        ? 'Workflows · loading…'
        : `Workflows · ${runs.length}`
      : loading
        ? 'Agents · loading…'
        : `Agents · ${agentCount}`;

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={` ${title} `}
      titleColor={theme.dim}
      bottomTitle={` ${panelHint(selected)} `}
      bottomTitleAlignment="right"
      backgroundColor={theme.bg}
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      {visible.map((row, offset) => (
        <PanelLine
          key={row.id}
          row={row}
          selected={start + offset === index}
          inner={inner}
          now={now}
        />
      ))}
      {notice ? (
        <text fg={notice.tone === 'error' ? theme.danger : theme.dim} wrapMode="none" height={1}>
          {notice.text.length > inner ? `${notice.text.slice(0, inner - 1)}…` : notice.text}
        </text>
      ) : null}
    </box>
  );
}

function PanelLine({
  row,
  selected,
  inner,
  now,
}: {
  row: PanelRow;
  selected: boolean;
  inner: number;
  now: number;
}) {
  if (row.kind === 'header' || row.kind === 'empty') {
    return (
      <text fg={theme.faint} wrapMode="none" height={1}>
        {` ${layoutRow(row.kind === 'header' ? row.title : row.text, '', inner - 1)}`}
      </text>
    );
  }
  let indent = ' ';
  let mark = { glyph: ' ', color: theme.faint };
  let label = '';
  let right = '';
  if (row.kind === 'agent') {
    mark = AGENT_GLYPH[row.agent.state];
    label = row.agent.line ? `${row.agent.handle} · ${row.agent.line}` : row.agent.handle;
    right = `${row.agent.teammate ? 'teammate · ' : ''}${agentState(row.agent, now)}`;
  } else if (row.kind === 'run') {
    mark = { glyph: row.expanded ? '▾' : '▸', color: theme.dim };
    label = row.run.title;
    right = runState(row.run);
  } else if (row.kind === 'run-agent') {
    indent = '   ';
    mark = RUN_AGENT_GLYPH[row.agent.status] ?? RUN_AGENT_GLYPH.stopped;
    label = row.agent.phase ? `${row.agent.label} · ${row.agent.phase}` : row.agent.label;
    right = runAgentState(row.agent, now);
  } else {
    mark = { glyph: '›', color: theme.accent };
    label = `${row.message.from_handle}: ${(row.message.summary ?? row.message.message).replace(/\s+/g, ' ').trim()}`;
    right = 'Held';
  }
  const room = inner - 1 - indent.length - 2;
  return (
    <text fg={selected ? theme.fg : theme.dim} wrapMode="none" height={1}>
      <span fg={theme.brand}>{selected ? '▌' : ' '}</span>
      {indent.slice(1)}
      <span fg={mark.color}>{mark.glyph}</span>
      {/* Every word here was written by an agent (a handle, a summary, a phase): no
          control character reaches the terminal. */}
      {` ${layoutRow(printable(label), printable(right), room)}`}
    </text>
  );
}

/** The current time, every second while `active`: a working row's elapsed time ticks. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface AgentsPanelProps {
  projectId: string | null;
  sessionId: string | null;
  width: number;
  only: PanelScope;
  onClose(): void;
}

/**
 * The live panel. Enter and `o` close it first: the peek and the switched
 * session take the keyboard, and a panel left open would keep it.
 */
export function AgentsPanel({ projectId, sessionId, width, only, onClose }: AgentsPanelProps) {
  const agents = useSessionAgents(projectId, sessionId);
  const nav = useAgentNav();
  const ticking =
    agents.groups.working.length > 0 || agents.runs.some((run) => run.status === 'running');
  const now = useNow(ticking);
  return (
    <AgentsPanelView
      groups={agents.groups}
      runs={agents.runs}
      held={agents.held}
      only={only}
      loading={agents.loading}
      notice={agents.notice}
      width={width}
      now={now}
      onPeek={(target) => {
        onClose();
        nav.peek(target);
      }}
      onOpen={(id) => {
        onClose();
        nav.switchTo(id);
      }}
      onStop={agents.stop}
      onControl={agents.control}
      onApprove={agents.approve}
      onDeny={agents.deny}
      onClose={onClose}
    />
  );
}
