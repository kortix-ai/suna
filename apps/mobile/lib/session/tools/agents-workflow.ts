/**
 * Pure logic behind the `workflow` card. Port of apps/web
 * `tool/tools/workflow-run-card.tsx` (Paper C19 / F1–F5) and the subtitle in
 * `tool/tools/workflow-tool.tsx`.
 *
 *   ◔  Kortix growth marketing deep dive
 *      Investigate 3 of 6 done · 7m 51s
 *   ── Investigate 3 of 6 done
 *   ◠  Customers and demand                         7m 51s
 *   ✓  Product and website                          5m 57s
 *   ┄┄
 *   ○  Build strategy · starts after Investigate    Waits for 2 more
 *
 * Strings are web's English locale (`tools.workflow`), as the other agent rows.
 */

import {
  countAgents,
  elapsedMs,
  formatElapsed,
  type WorkflowRun,
  type WorkflowRunAgent,
} from '@kortix/sdk';
import type { SessionDisplayStatus } from '@/lib/session/session-list';

type AgentStatus = WorkflowRunAgent['status'];

/** The session-list mark each agent or phase status draws. */
export const RUN_GLYPH: Record<AgentStatus | 'pending', SessionDisplayStatus> = {
  starting: 'starting',
  pending: 'stopped',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** Failed first: it waits on a decision. Then the work in flight, then the finished. */
const ORDER: Record<AgentStatus, number> = { failed: 0, running: 1, starting: 2, stopped: 3, done: 4 };

export interface WorkflowAgentRowModel {
  id: string;
  label: string;
  glyph: SessionDisplayStatus;
  /** A word for a state worth naming (Didn't finish, Starting, Stopped); null for working and done. */
  state: string | null;
  failed: boolean;
  /** A failed agent's reason, drawn under its name in red. */
  reason: string | null;
  time: string | null;
  sessionId: string | null;
}

export type WorkflowGroupModel =
  | {
      kind: 'phase';
      title: string | null;
      progress: string | null;
      /** The phase's ring: its agents done and failed, and whether the phase ended. */
      ring: { done: number; failed: number; total: number; ended: 'done' | 'stopped' | null };
      /** "4 running · 1 failed": what the closed phase is doing; null when nothing runs or failed. */
      failed: string | null;
      rows: WorkflowAgentRowModel[];
    }
  | { kind: 'pending'; title: string; after: string | null; waits: string };

export interface WorkflowCardModel {
  title: string;
  subtitle: string;
  failedTone: boolean;
  ring: { done: number; failed: number; total: number; ended: 'done' | 'stopped' | null };
  /** The run ended and has a run of its own to open: the card is its header. */
  headerOnly: boolean;
  groups: WorkflowGroupModel[];
}

const join = (...parts: (string | undefined | null | false)[]) => parts.filter(Boolean).join(' · ');

function progressLine(done: number, total: number): string {
  return `${done} of ${total} done`;
}

function agentRow(agent: WorkflowRunAgent, live: boolean, now: number): WorkflowAgentRowModel {
  const working = agent.status === 'running' || agent.status === 'starting';
  const elapsed = elapsedMs(agent, live && working, now);
  const state =
    agent.status === 'failed'
      ? 'Didn’t finish'
      : agent.status === 'starting'
        ? 'Starting'
        : agent.status === 'stopped'
          ? 'Stopped'
          : null;
  return {
    id: agent.id,
    label: agent.label,
    glyph: RUN_GLYPH[agent.status],
    state,
    failed: agent.status === 'failed',
    reason: agent.status === 'failed' ? (agent.summary ?? null) : null,
    time: elapsed !== undefined && agent.status !== 'failed' ? formatElapsed(elapsed) : null,
    sessionId: agent.sessionId ?? null,
  };
}

function sortRows(agents: readonly WorkflowRunAgent[]): WorkflowRunAgent[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => ORDER[a.agent.status] - ORDER[b.agent.status] || a.index - b.index)
    .map(({ agent }) => agent);
}

/** Agents under their phase, in phase order; a phase not started is one muted row. Agents of no phase come first. */
export function workflowGroups(run: WorkflowRun, live: boolean, now: number): WorkflowGroupModel[] {
  const unfinished = run.agents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length;
  const known = new Set(run.phases.map((phase) => phase.title));
  const loose = run.agents.filter((agent) => !agent.phase || !known.has(agent.phase));
  const groups: WorkflowGroupModel[] = [];
  if (loose.length > 0)
    groups.push({ kind: 'phase', title: null, progress: null, ring: { done: 0, failed: 0, total: 0, ended: null }, failed: null, rows: sortRows(loose).map((a) => agentRow(a, live, now)) });
  run.phases.forEach((phase, index) => {
    const agents = run.agents.filter((agent) => agent.phase === phase.title);
    if (phase.status === 'pending' && agents.length === 0) {
      groups.push({
        kind: 'pending',
        title: phase.title,
        after: index > 0 ? run.phases[index - 1]!.title : null,
        waits: unfinished > 0 ? `Waits for ${unfinished} more` : 'Not started',
      });
      return;
    }
    const tally = countAgents(agents);
    groups.push({
      kind: 'phase',
      title: phase.title,
      progress: tally.total > 0 ? progressLine(tally.done, tally.total) : null,
      ring: {
        done: tally.done,
        failed: tally.failed,
        total: tally.total,
        ended: phase.status === 'done' && tally.total > 0 && tally.done === tally.total ? 'done' : phase.status === 'stopped' ? 'stopped' : null,
      },
      // A closed phase still says it is at work (web `PhaseRow`): "4 running · 1 failed".
      failed:
        [
          agents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length || null,
          tally.failed > 0 ? `${tally.failed} failed` : null,
        ]
          .map((part, i) => (i === 0 && part ? `${part} running` : part))
          .filter(Boolean)
          .join(' · ') || null,
      rows: sortRows(agents).map((a) => agentRow(a, live, now)),
    });
  });
  return groups;
}

export function workflowCardModel(run: WorkflowRun, opts: { live: boolean; now: number; settled: boolean }): WorkflowCardModel {
  const counts = countAgents(run.agents);
  const progress = counts.total > 0 ? progressLine(counts.done, counts.total) : undefined;
  const failedPart = counts.failed > 0 ? `${counts.failed} failed` : undefined;
  const runElapsed = elapsedMs(run, opts.live, opts.now);
  const elapsed = runElapsed !== undefined && runElapsed >= 1_000 ? formatElapsed(runElapsed) : undefined;
  const phase = run.phases.find((p) => p.status === 'running');
  const phaseTally = phase ? countAgents(run.agents.filter((agent) => agent.phase === phase.title)) : null;
  const phaseLine = phase && phaseTally && phaseTally.total > 0 ? `${phase.title} ${progressLine(phaseTally.done, phaseTally.total)}` : undefined;
  const paused = run.paused ? 'Paused' : undefined;

  const subtitle =
    run.status === 'running'
      ? join(paused ?? (opts.settled || run.background ? 'Running in the background' : undefined), phaseLine ?? progress, failedPart, elapsed)
      : run.status === 'done'
        ? join('Done', counts.total > 0 ? `${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}` : undefined, elapsed)
        : run.status === 'failed'
          ? join('Didn’t finish', counts.total > 0 ? progress : undefined, failedPart, elapsed)
          : join('Stopped', counts.total > 0 ? progress : undefined, elapsed);

  return {
    title: run.title || run.name || 'Workflow',
    subtitle,
    failedTone: run.status === 'failed',
    ring: {
      done: counts.done,
      failed: counts.failed,
      total: counts.total,
      ended: run.status === 'done' ? 'done' : run.status === 'stopped' ? 'stopped' : null,
    },
    headerOnly: run.status !== 'running' && !!run.background,
    groups: workflowGroups(run, opts.live, opts.now),
  };
}

/** How a background run ended, from its runner session's display status; null while it still runs. */
export function runnerOutcome(status: SessionDisplayStatus | null | undefined): 'done' | 'failed' | 'stopped' | null {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  return null;
}

export const RUNNER_OUTCOME_LABEL: Record<'done' | 'failed' | 'stopped', string> = {
  done: 'Done',
  failed: 'Didn’t finish',
  stopped: 'Stopped',
};
