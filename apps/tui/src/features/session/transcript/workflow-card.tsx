/**
 * A `workflow` call as a run card, as Claude Code draws a workflow run:
 *
 *   ⠙ Weekly competitor review
 *     1 of 4 done · 1 failed · 2m 10s · Paused
 *     › the newest log line
 *     Research · 1 of 3 done
 *       ✓ Research pricing · researcher                    ses_a1 · 12s
 *         ⎿ Found 4 price changes
 *       ⠙ Research reviews · researcher                    ses_a3 · 40s
 *     Write · Not started
 *     /workflows to pause, stop or open an agent
 *
 * The run is the call's part metadata (`WorkflowRunMetadata`, parsed by the SDK's
 * `parseWorkflowRun`). That copy stops updating once the caller's turn ends, and a
 * background run never updates it at all: then the card reads the live run from the
 * box that runs it (`useSessionWorkflows`, the caller's session or a background run's
 * runner) and shows that copy when its `runId` matches. Outside a transcript session
 * (`useTranscriptSession` ids null) the card draws the part alone.
 *
 * A click on an agent row opens the peek at its session (`useAgentNav`), as an
 * `agent` row does. Keys stay with `/workflows` and `/agents`; the card adds none.
 */

import {
  type SessionLogMessage,
  type ToolView,
  WORKFLOW_LARGE_AGENT_COUNT,
  type WorkflowRun,
  type WorkflowRunAgent,
  classifySessionLogMessage,
  countAgents,
  elapsedMs,
  formatElapsed,
  groupAgents,
  isWorkflowTool,
  noticeFirstLine,
  parseWorkflowRun,
  structuredSummary,
} from '@kortix/sdk';
import { useSessionView, useSessionWorkflows } from '@kortix/sdk/react';
import { useEffect, useMemo, useState } from 'react';

import { printable } from '../../../lib/printable.ts';
import { clip } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';
import { Spinner } from '../../../ui/index.ts';
import { useAgentNav } from '../../agents/agent-nav.tsx';
import { useTranscriptSession } from './session-context.tsx';

/** Agent rows a card draws: the running ones first, then the newest settled ones. */
export const WORKFLOW_AGENT_ROWS = 8;
/** `log()` lines a card draws: the newest ones. */
export const WORKFLOW_LOG_LINES = 2;
export const WORKFLOW_HINT = '/workflows to pause, stop or open an agent';

const STATUS_WORD = {
  starting: 'Starting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  pending: 'Not started',
} as const;

const isActive = (agent: WorkflowRunAgent) =>
  agent.status === 'starting' || agent.status === 'running';

/**
 * The ids of the agents a card draws, at most `cap`: every running or starting
 * agent first, then the newest settled agents. The rest are "… N more".
 */
export function visibleAgentIds(
  agents: readonly WorkflowRunAgent[],
  cap = WORKFLOW_AGENT_ROWS,
): Set<string> {
  const shown = new Set<string>();
  for (const agent of agents) {
    if (shown.size >= cap) return shown;
    if (isActive(agent)) shown.add(agent.id);
  }
  for (let i = agents.length - 1; i >= 0 && shown.size < cap; i -= 1) {
    const agent = agents[i];
    if (agent) shown.add(agent.id);
  }
  return shown;
}

/** The current time, every second while `active`: a live run's elapsed labels tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function RunGlyph({ run, live }: { run: WorkflowRun; live: boolean }) {
  if (run.status === 'running') return live ? <Spinner /> : <text fg={theme.dim}>·</text>;
  if (run.status === 'failed') return <text fg={theme.danger}>✗</text>;
  if (run.status === 'stopped') return <text fg={theme.dim}>–</text>;
  return <text fg={theme.ok}>✓</text>;
}

function AgentGlyph({ agent }: { agent: WorkflowRunAgent }) {
  switch (agent.status) {
    case 'running':
      return <Spinner />;
    case 'starting':
      return <text fg={theme.dim}>○</text>;
    case 'done':
      return <text fg={theme.ok}>✓</text>;
    case 'failed':
      return <text fg={theme.danger}>✗</text>;
    case 'stopped':
      return <text fg={theme.dim}>–</text>;
  }
}

/** The one line under a settled agent: its answer's first line, a structured answer's shape, or why it failed. */
function agentSummary(agent: WorkflowRunAgent): string | null {
  if (!agent.summary || isActive(agent)) return null;
  if (agent.structured) {
    const parsed = structuredSummary(agent.summary);
    if (parsed.kind === 'object') return `JSON · ${parsed.keys} key${parsed.keys === 1 ? '' : 's'}`;
    if (parsed.kind === 'array')
      return `JSON · ${parsed.items} item${parsed.items === 1 ? '' : 's'}`;
  }
  return noticeFirstLine(agent.summary) || null;
}

function AgentLine({
  agent,
  live,
  now,
  width,
}: { agent: WorkflowRunAgent; live: boolean; now: number; width: number }) {
  const nav = useAgentNav();
  const label = printable(agent.label);
  const handle = agent.agent ? printable(agent.agent) : '';
  const ms = elapsedMs(agent, live && isActive(agent), now);
  const right = [
    agent.sessionId ? agent.sessionId.slice(0, 8) : null,
    agent.status === 'starting' ? STATUS_WORD.starting : null,
    agent.cached ? 'from last run' : null,
    agent.attempt && agent.attempt > 1 ? `retry ${agent.attempt - 1}` : null,
    ms !== undefined && ms >= 1_000 ? formatElapsed(ms) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const inner = Math.max(width - 4, 12);
  const name = clip(label, Math.max(inner - right.length - 4, 8));
  const rest = handle
    ? clip(` · ${handle}`, Math.max(inner - name.length - right.length - 4, 0))
    : '';
  const summary = agentSummary(agent);
  const open = () => {
    if (agent.sessionId) nav.peek({ sessionId: agent.sessionId, title: label });
  };
  return (
    <box flexDirection="column" paddingLeft={4} onMouseDown={open}>
      <box flexDirection="row" height={1}>
        <AgentGlyph agent={agent} />
        <text wrapMode="none" flexGrow={1}>
          <span fg={agent.status === 'stopped' ? theme.dim : theme.fg}>{` ${name}`}</span>
          <span fg={theme.dim}>{rest}</span>
        </text>
        {right ? (
          <text fg={theme.faint} wrapMode="none">
            {` ${right}`}
          </text>
        ) : null}
      </box>
      {summary ? (
        <text fg={agent.status === 'failed' ? theme.danger : theme.faint} wrapMode="none">
          {`  ⎿ ${clip(printable(summary), Math.max(inner - 4, 8))}`}
        </text>
      ) : null}
    </box>
  );
}

export interface WorkflowRunViewProps {
  run: WorkflowRun;
  /** The run still works and this card follows it: spinners turn and elapsed time ticks. */
  live: boolean;
  width: number;
}

/** The card for one run, drawn from the run alone. */
export function WorkflowRunView({ run, live, width }: WorkflowRunViewProps) {
  const now = useNow(live);
  const inner = Math.max(width - 2, 12);
  const counts = countAgents(run.agents);
  const runMs = elapsedMs(run, live, now);
  const background = run.status === 'running' && Boolean(run.background) && !live;
  const progress = [
    counts.total > 0
      ? `${counts.done} of ${counts.total} done`
      : run.status === 'running'
        ? background
          ? null
          : 'Starting'
        : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    background ? 'Running in the background' : null,
    !background && runMs !== undefined && runMs >= 1_000 ? formatElapsed(runMs) : null,
    run.paused ? 'Paused' : null,
    run.resumedFrom ? 'Resumed' : null,
    run.large || run.agents.length > WORKFLOW_LARGE_AGENT_COUNT ? 'Large run' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const error = run.status === 'failed' && run.error ? run.error.split('\n')[0] : null;
  const logs = run.logs.slice(-WORKFLOW_LOG_LINES);
  const visible = visibleAgentIds(run.agents);
  const groups = groupAgents(run);
  const title = printable(run.title || run.name || 'Workflow');

  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1}>
        <RunGlyph run={run} live={live} />
        <text fg={theme.fg} wrapMode="none">{` ${clip(title, inner)}`}</text>
      </box>
      {progress ? <text fg={theme.dim} wrapMode="none">{`  ${clip(progress, inner)}`}</text> : null}
      {error ? (
        <text fg={theme.danger} wrapMode="none">{`  ${clip(printable(error), inner)}`}</text>
      ) : null}
      {logs.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: log lines carry no id
        <text key={`log-${index}`} fg={theme.faint} wrapMode="none">
          {`  › ${clip(printable(line), inner - 4)}`}
        </text>
      ))}
      {groups.map((group) => {
        const shown = group.agents.filter((agent) => visible.has(agent.id));
        const hidden = group.agents.length - shown.length;
        const groupCounts = countAgents(group.agents);
        const phaseState =
          group.phase?.status === 'pending'
            ? STATUS_WORD.pending
            : groupCounts.total > 0
              ? `${groupCounts.done} of ${groupCounts.total} done`
              : group.phase
                ? STATUS_WORD[group.phase.status]
                : '';
        return (
          <box key={group.phase ? `phase:${group.phase.title}` : 'loose'} flexDirection="column">
            {group.phase ? (
              <text wrapMode="none">
                <span
                  fg={group.phase.status === 'pending' ? theme.faint : theme.fg}
                >{`  ${clip(printable(group.phase.title), inner - phaseState.length - 4)}`}</span>
                <span fg={theme.faint}>{phaseState ? ` · ${phaseState}` : ''}</span>
              </text>
            ) : null}
            {shown.map((agent) => (
              <AgentLine key={agent.id} agent={agent} live={live} now={now} width={width} />
            ))}
            {hidden > 0 ? <text fg={theme.faint}>{`    … ${hidden} more`}</text> : null}
          </box>
        );
      })}
      <text fg={theme.faint} wrapMode="none">{`  ${clip(WORKFLOW_HINT, inner)}`}</text>
    </box>
  );
}

/** The live copy of a run from the box that runs it, or the part's copy until one arrives. */
function LiveWorkflowCard({
  run,
  projectId,
  boxSessionId,
  width,
}: { run: WorkflowRun; projectId: string; boxSessionId: string; width: number }) {
  // The run's final copy, once a source reported it ended. Latched: the card then reads
  // nothing more. The call's snapshot says "running" for good, so without the latch a
  // finished run kept a poll and a stream open for as long as the transcript showed it.
  const [final, setFinal] = useState<WorkflowRun | null>(null);
  const { data } = useSessionWorkflows(projectId, boxSessionId, {
    enabled: run.status === 'running' && !final,
  });
  const live = useMemo(() => {
    const match = run.runId ? data?.find((candidate) => candidate.runId === run.runId) : undefined;
    const parsed = match ? parseWorkflowRun(match) : null;
    // The runner runs it in the foreground; this card still knows it as a background run.
    return parsed ? { ...parsed, ...(run.background ? { background: run.background } : {}) } : null;
  }, [data, run]);
  // The runner's box sleeps after the run: then its own log is the record. The runner ran the
  // `workflow` call in its session, so that call's metadata is the run's final document. A view
  // reads it from the API alone, without waking the box.
  const runner = run.background?.sessionId ?? null;
  const view = useSessionView(projectId, runner ?? '', {
    enabled: Boolean(runner) && !live && !final,
  });
  const logged = useMemo(
    () => (view.thread ? runFromThread(view.thread.messages, run.runId) : null),
    [view.thread, run.runId],
  );
  const current =
    live ??
    (logged ? { ...logged, ...(run.background ? { background: run.background } : {}) } : null);
  useEffect(() => {
    if (!final && current && current.status !== 'running') setFinal(current);
  }, [final, current]);
  const shown = final ?? current ?? run;
  return (
    <WorkflowRunView run={shown} live={Boolean(live) && shown.status === 'running'} width={width} />
  );
}

/** The run documents of a session's `workflow` calls (their metadata), newest first. */
export function workflowRunDocs(messages: readonly SessionLogMessage[]): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    for (const part of classifySessionLogMessage(message).parts) {
      if (part.kind === 'tool' && isWorkflowCall(part.tool) && part.tool.metadata)
        docs.push(part.tool.metadata);
    }
  }
  return docs;
}

/** The newest `workflow` call of a session whose metadata is the run `runId` (any run without one). */
export function runFromThread(
  messages: readonly SessionLogMessage[],
  runId: string | undefined,
): WorkflowRun | null {
  for (const doc of workflowRunDocs(messages)) {
    const parsed = parseWorkflowRun(doc);
    if (parsed && (!runId || parsed.runId === runId)) return parsed;
  }
  return null;
}

export interface WorkflowCardProps {
  tool: ToolView;
  /** `parseWorkflowRun(tool.metadata)`: the caller checked it is a run. */
  run: WorkflowRun;
  width: number;
}

export function WorkflowCard({ tool, run, width }: WorkflowCardProps) {
  const { projectId, sessionId } = useTranscriptSession();
  const callActive = tool.status === 'running' || tool.status === 'pending';
  // While the call runs, its part carries every change of the run. Once it returned
  // (the turn ended, or a background run handed off at once) the part is a snapshot.
  const boxSessionId = run.background?.sessionId ?? sessionId;
  if (!callActive && run.status === 'running' && projectId && boxSessionId) {
    return (
      <LiveWorkflowCard run={run} projectId={projectId} boxSessionId={boxSessionId} width={width} />
    );
  }
  return <WorkflowRunView run={run} live={callActive && run.status === 'running'} width={width} />;
}

/** True for pi's `workflow` tool, by kind or by any spelling of its name. */
export function isWorkflowCall(tool: ToolView): boolean {
  return tool.kind === 'workflow' || isWorkflowTool(tool.name);
}
