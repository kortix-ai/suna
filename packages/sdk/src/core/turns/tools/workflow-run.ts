/**
 * The `workflow` tool's run document, parsed defensively, and the pure helpers
 * a run card draws from (web, TUI, mobile).
 *
 * The shape is `WorkflowRunMetadata` (`core/rest/projects-client/multi-agent.ts`,
 * held equal to `packages/api-contract/src/kortix-tool-card.ts`). It arrives as a
 * tool part's metadata (`ToolView.metadata`) or from `GET …/workflows`, so every
 * field is checked. pi pushes it live with every change of the run, and the
 * final copy when the call returns.
 */
import type {
  WorkflowAgentStatus,
  WorkflowRunAgent,
  WorkflowRunPhase,
  WorkflowRunStatus,
} from '../../rest/projects-client/multi-agent';

/** A phase's status. `pending`: declared in the script's `meta.phases`, not started yet. */
export type WorkflowPhaseStatus = WorkflowRunPhase['status'];

/**
 * A run as a card draws it: `WorkflowRunMetadata` after `parseWorkflowRun`, with
 * `logs` always a list and the newest 5 lines at most.
 */
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A cut block: a document inside it still reads as the document.
      const fields = body.startsWith('{') ? cutStringFields(body) : null;
      const recovered = fields ? documentOf(fields) : null;
      return { kind: 'markdown', text: recovered ?? body };
    }
    const document = isRecord(parsed) ? documentOf(Object.entries(parsed)) : null;
    if (document) return { kind: 'markdown', text: document };
    return { kind: 'json', text: prettyJson(parsed, body) };
  }
  return { kind: 'markdown', text: body };
}

/**
 * JSON pretty-printed, or the body as it came when that cannot be done safely:
 * deep nesting overflows `JSON.stringify`'s stack, and its indentation grows with
 * the square of the depth, so the printed text is capped against the input.
 */
function prettyJson(value: unknown, body: string): string {
  if (nestingDepth(body) > 64) return body;
  try {
    const pretty = JSON.stringify(value, null, 2);
    return pretty.length <= body.length * 4 + 10_000 ? pretty : body;
  } catch {
    return body;
  }
}

/** How deep the brackets of a JSON text nest, strings skipped. Linear time. */
function nestingDepth(body: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') max = Math.max(max, ++depth);
    else if (char === '}' || char === ']') depth -= 1;
  }
  return max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string a person reads, not a value: it spans lines, or runs long as words (a long URL or token is data). */
function isProse(value: string): boolean {
  return value.includes('\n') || (value.length >= 120 && /\s/.test(value.trim()));
}

/** `growthPlan` / `growth_plan` → `Growth plan`. */
function fieldTitle(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A JSON result whose values are all strings, at least one of them prose, is a
 * document: one field is the text itself, several are `## Field` sections in order.
 * Anything else (numbers, arrays, short labels) is data and stays JSON.
 */
function documentOf(fields: [string, unknown][]): string | null {
  if (fields.length === 0) return null;
  if (!fields.every((entry): entry is [string, string] => typeof entry[1] === 'string')) return null;
  if (!fields.some(([, value]) => isProse(value))) return null;
  if (fields.length === 1) return fields[0]![1].trim();
  return fields.map(([key, value]) => `## ${fieldTitle(key)}\n\n${value.trim()}`).join('\n\n');
}

/**
 * The `"key": "value"` pairs of a JSON object cut short, in order, with the
 * escapes decoded; the last value runs to the cut. Linear time, no regex backtracking.
 */
function cutStringFields(body: string): [string, string][] | null {
  const fields: [string, string][] = [];
  const pair = /\s*"((?:[^"\\]|\\.)*)"\s*:\s*"/y;
  let at = 1;
  while (at < body.length) {
    pair.lastIndex = at;
    const head = pair.exec(body);
    // No `"key": "` here: either the cut fell inside the next key (fine), or the next value is data,
    // and a document recovered without it would drop that data silently.
    if (!head) return /^\s*(?:"(?:[^"\\]|\\.)*(?:"\s*(?::\s*)?)?)?$/.test(body.slice(at)) ? fields : null;
    let value = '';
    let i = pair.lastIndex;
    let closed = false;
    while (i < body.length) {
      const char = body[i]!;
      if (char === '"') {
        closed = true;
        i += 1;
        break;
      }
      if (char !== '\\') {
        value += char;
        i += 1;
        continue;
      }
      const next = body[i + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const code = body.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(code)) break;
        value += String.fromCharCode(Number.parseInt(code, 16));
        i += 6;
        continue;
      }
      value += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next;
      i += 2;
    }
    fields.push([decodeKey(head[1]!), value]);
    if (!closed) break;
    const comma = /\s*,/y;
    comma.lastIndex = i;
    if (!comma.exec(body)) break;
    at = comma.lastIndex;
  }
  return fields;
}

/** A captured JSON key with its escapes decoded, as `JSON.parse` would give it. */
function decodeKey(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}
