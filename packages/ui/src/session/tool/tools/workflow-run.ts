/**
 * The `workflow` tool's part metadata, parsed defensively, and the pure helpers
 * its card draws from.
 *
 * The shape is `WorkflowRunMetadata` in `packages/api-contract/src/kortix-tool-card.ts`.
 * `@kortix/ui` does not depend on that package, so the types are mirrored here
 * and every field is checked. pi pushes it live with every change of the run,
 * and the final copy when the call returns.
 */

export type WorkflowRunStatus = 'running' | 'done' | 'failed' | 'stopped';
/** `pending`: declared in the script's `meta.phases`, not started yet. */
export type WorkflowPhaseStatus = WorkflowRunStatus | 'pending';
export type WorkflowAgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped';

export interface WorkflowRunPhase {
  title: string;
  status: WorkflowPhaseStatus;
}

export interface WorkflowRunAgent {
  id: string;
  label: string;
  agent?: string;
  phase?: string;
  status: WorkflowAgentStatus;
  sessionId?: string;
  summary?: string;
  /** Resumed run: the saved result of the earlier run was reused; no session started. */
  cached?: true;
  /** The model the script asked for. */
  model?: string;
  /** The answer is JSON checked against a schema. */
  structured?: true;
  /** 1 for the first attempt; a stalled agent restarts with the same prompt. */
  attempt?: number;
  /** Epoch ms. */
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowRun {
  runId: string;
  title: string;
  status: WorkflowRunStatus;
  phases: WorkflowRunPhase[];
  agents: WorkflowRunAgent[];
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /** The most agents this run may start. */
  maxAgents?: number;
  /** A saved workflow run by name. */
  name?: string;
  /** The script's newest `log()` lines, oldest first. */
  logs: string[];
  /** More than 25 agents: the card warns, as Claude Code's "Large workflow". */
  large?: true;
  /** The run this one resumed. */
  resumedFrom?: string;
  /** The run goes on in its own runner session; this call returned at once. */
  background?: { sessionId: string };
  /** `pause` held new agents back; running agents finish. Cleared by `resume`. */
  paused?: true;
}

const RUN_STATUSES = new Set<WorkflowRunStatus>(['running', 'done', 'failed', 'stopped']);
const PHASE_STATUSES = new Set<WorkflowPhaseStatus>(['pending', 'running', 'done', 'failed', 'stopped']);
const AGENT_STATUSES = new Set<WorkflowAgentStatus>(['starting', 'running', 'done', 'failed', 'stopped']);
/** A run's rows stay a list a person can read; the rest is the session list's job. */
const MAX_AGENTS = 200;
/** The contract sends at most 5 `log()` lines; a longer list keeps the newest 5. */
const MAX_LOGS = 5;
const MAX_LOG_CHARS = 500;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const time = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;

function phase(entry: unknown): WorkflowRunPhase | undefined {
  if (!isObject(entry)) return undefined;
  const title = text(entry.title);
  return title && PHASE_STATUSES.has(entry.status as WorkflowPhaseStatus)
    ? { title, status: entry.status as WorkflowPhaseStatus }
    : undefined;
}

function agent(entry: unknown, index: number): WorkflowRunAgent | undefined {
  if (!isObject(entry) || !AGENT_STATUSES.has(entry.status as WorkflowAgentStatus)) return undefined;
  const label = text(entry.label) ?? text(entry.agent);
  if (!label) return undefined;
  const name = text(entry.agent);
  const phaseTitle = text(entry.phase);
  const sessionId = text(entry.sessionId);
  const summary = text(entry.summary);
  const model = text(entry.model);
  const attempt = count(entry.attempt);
  const startedAt = time(entry.startedAt);
  const endedAt = time(entry.endedAt);
  return {
    id: text(entry.id) ?? `a${index + 1}`,
    label,
    ...(name ? { agent: name } : {}),
    ...(phaseTitle ? { phase: phaseTitle } : {}),
    status: entry.status as WorkflowAgentStatus,
    ...(sessionId ? { sessionId } : {}),
    ...(summary ? { summary } : {}),
    ...(entry.cached === true ? { cached: true as const } : {}),
    ...(model ? { model } : {}),
    ...(entry.structured === true ? { structured: true as const } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

function logs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((line) => text(line))
    .filter((line): line is string => line !== undefined)
    .slice(-MAX_LOGS)
    .map((line) => line.slice(0, MAX_LOG_CHARS));
}

/** The run in a `workflow` call's metadata; `null` when the metadata is not a run. */
export function parseWorkflowRun(metadata: unknown): WorkflowRun | null {
  if (!isObject(metadata)) return null;
  // A background call that handed its run to a runner may say `started`: the run runs.
  if (metadata.status === 'started') metadata = { ...metadata, status: 'running', agents: Array.isArray(metadata.agents) ? metadata.agents : [] };
  if (!isObject(metadata) || !RUN_STATUSES.has(metadata.status as WorkflowRunStatus)) return null;
  if (!Array.isArray(metadata.agents)) return null;
  const agents: WorkflowRunAgent[] = [];
  for (const [index, entry] of metadata.agents.slice(0, MAX_AGENTS).entries()) {
    const parsed = agent(entry, index);
    if (parsed) agents.push(parsed);
  }
  const phases = Array.isArray(metadata.phases)
    ? metadata.phases.map(phase).filter((p): p is WorkflowRunPhase => p !== undefined)
    : [];
  const startedAt = time(metadata.startedAt);
  const endedAt = time(metadata.endedAt);
  const error = text(metadata.error);
  const maxAgents = count(metadata.maxAgents);
  const name = text(metadata.name);
  const resumedFrom = text(metadata.resumedFrom);
  // A background run names its runner session as `background.sessionId`, or (a started call's
  // details) as `runnerSessionId` / `runner_session_id`.
  const backgroundSession =
    (isObject(metadata.background) ? text(metadata.background.sessionId) : undefined) ??
    text(metadata.runnerSessionId) ??
    text(metadata.runner_session_id);
  return {
    runId: text(metadata.runId) ?? '',
    title: text(metadata.title) ?? '',
    status: metadata.status as WorkflowRunStatus,
    phases,
    agents,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(error ? { error } : {}),
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(name ? { name } : {}),
    logs: logs(metadata.logs),
    ...(metadata.large === true ? { large: true as const } : {}),
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(backgroundSession ? { background: { sessionId: backgroundSession } } : {}),
    ...(metadata.paused === true ? { paused: true as const } : {}),
  };
}

/** True for pi's `workflow` tool, under any of its spellings, and for no other name ending in `workflow`. */
export function isWorkflowTool(name: string): boolean {
  return name.replace(/^oc[-_]/, '') === 'workflow';
}

// ── Counting and grouping ────────────────────────────────────────────────────

/** The filter of the agent list, as Claude Code's `f` cycles it. */
export type AgentFilter = 'all' | 'running' | 'failed' | 'done';
export const AGENT_FILTERS: readonly AgentFilter[] = ['all', 'running', 'failed', 'done'];

/** Whether an agent belongs under a filter. `stopped` is listed under `all` only. */
export function agentMatches(agent: WorkflowRunAgent, filter: AgentFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'running':
      return agent.status === 'starting' || agent.status === 'running';
    case 'failed':
      return agent.status === 'failed';
    case 'done':
      return agent.status === 'done';
  }
}

export interface AgentCounts {
  total: number;
  running: number;
  failed: number;
  done: number;
}

export function countAgents(agents: readonly WorkflowRunAgent[]): AgentCounts {
  const counts: AgentCounts = { total: agents.length, running: 0, failed: 0, done: 0 };
  for (const agent of agents) {
    if (agentMatches(agent, 'running')) counts.running += 1;
    else if (agent.status === 'failed') counts.failed += 1;
    else if (agent.status === 'done') counts.done += 1;
  }
  return counts;
}

/** One group of the progress list: a phase and its agents, or the agents started before any phase. */
export interface AgentGroup {
  /** `null`: the agents that belong to no phase. They come first and have no header. */
  phase: WorkflowRunPhase | null;
  agents: WorkflowRunAgent[];
}

/**
 * The agents grouped under their phases, in the run's phase order. An agent whose
 * phase the list does not name gets a group of its own after the named ones, as a
 * `phase()` title with no `meta.phases` entry does in Claude Code.
 */
export function groupAgents(run: Pick<WorkflowRun, 'phases' | 'agents'>): AgentGroup[] {
  const loose: WorkflowRunAgent[] = [];
  const byPhase = new Map<string, WorkflowRunAgent[]>();
  for (const phase of run.phases) if (!byPhase.has(phase.title)) byPhase.set(phase.title, []);
  const extra: string[] = [];
  for (const agent of run.agents) {
    if (!agent.phase) {
      loose.push(agent);
      continue;
    }
    let list = byPhase.get(agent.phase);
    if (!list) {
      list = [];
      byPhase.set(agent.phase, list);
      extra.push(agent.phase);
    }
    list.push(agent);
  }
  const groups: AgentGroup[] = loose.length > 0 ? [{ phase: null, agents: loose }] : [];
  const seen = new Set<string>();
  for (const phase of run.phases) {
    if (seen.has(phase.title)) continue;
    seen.add(phase.title);
    groups.push({ phase, agents: byPhase.get(phase.title) ?? [] });
  }
  for (const title of extra) {
    const agents = byPhase.get(title) ?? [];
    groups.push({ phase: { title, status: derivedStatus(agents) }, agents });
  }
  return groups;
}

function derivedStatus(agents: readonly WorkflowRunAgent[]): WorkflowPhaseStatus {
  if (agents.some((agent) => agentMatches(agent, 'running'))) return 'running';
  if (agents.some((agent) => agent.status === 'failed')) return 'failed';
  return 'done';
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** `12s`, `3m 04s`, `1h 05m`. Seconds and minutes are zero-padded so a ticking label keeps its width. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** How long a run or an agent took, or has taken by `now`; undefined when its start is unknown or it never ran. */
export function elapsedMs(
  item: { startedAt?: number; endedAt?: number },
  live: boolean,
  now: number,
): number | undefined {
  if (item.startedAt === undefined) return undefined;
  if (item.endedAt !== undefined) return Math.max(0, item.endedAt - item.startedAt);
  return live ? Math.max(0, now - item.startedAt) : undefined;
}

// ── Answers ──────────────────────────────────────────────────────────────────

export type StructuredSummary =
  | { kind: 'object'; keys: number; pretty: string }
  | { kind: 'array'; items: number; pretty: string }
  | { kind: 'value'; pretty: string }
  | { kind: 'text'; pretty: string };

/** A `structured` agent's summary: the JSON it holds, or its text when it does not parse (a cut answer). */
export function structuredSummary(summary: string): StructuredSummary {
  try {
    const value: unknown = JSON.parse(summary);
    const pretty = JSON.stringify(value, null, 2);
    if (Array.isArray(value)) return { kind: 'array', items: value.length, pretty };
    if (isObject(value)) return { kind: 'object', keys: Object.keys(value).length, pretty };
    return { kind: 'value', pretty };
  } catch {
    return { kind: 'text', pretty: summary };
  }
}

export type WorkflowResult = { kind: 'json'; text: string } | { kind: 'markdown'; text: string };

/**
 * The script's return value in a finished call's output (`<workflow_result>…</workflow_result>`):
 * pretty JSON when it parses as an object or a list, else Markdown. Null when the output has no
 * result block (an older run, or a run that failed).
 */
export function parseWorkflowResult(output: string): WorkflowResult | null {
  const open = output.indexOf('<workflow_result>');
  if (open === -1) return null;
  const start = open + '<workflow_result>'.length;
  const close = output.indexOf('</workflow_result>', start);
  const body = (close === -1 ? output.slice(start) : output.slice(start, close)).trim();
  if (!body) return null;
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      return { kind: 'json', text: JSON.stringify(JSON.parse(body), null, 2) };
    } catch {
      // A cut or hand-written block: show it as text.
    }
  }
  return { kind: 'markdown', text: body };
}
