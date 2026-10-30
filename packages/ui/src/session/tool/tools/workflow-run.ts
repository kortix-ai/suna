/**
 * The `workflow` tool's part metadata, parsed defensively.
 *
 * The shape is `WorkflowRunMetadata` in `packages/api-contract/src/kortix-tool-card.ts`.
 * `@kortix/ui` does not depend on that package, so the types are mirrored here
 * and every field is checked. pi pushes it live with every change of the run,
 * and the final copy when the call returns.
 */

export type WorkflowRunStatus = 'running' | 'done' | 'failed' | 'stopped';
export type WorkflowAgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped';

export interface WorkflowRunPhase {
  title: string;
  status: WorkflowRunStatus;
}

export interface WorkflowRunAgent {
  id: string;
  label: string;
  agent?: string;
  phase?: string;
  status: WorkflowAgentStatus;
  sessionId?: string;
  summary?: string;
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
}

const RUN_STATUSES = new Set<WorkflowRunStatus>(['running', 'done', 'failed', 'stopped']);
const AGENT_STATUSES = new Set<WorkflowAgentStatus>(['starting', 'running', 'done', 'failed', 'stopped']);
/** A run's rows stay a list a person can read; the rest is the session list's job. */
const MAX_AGENTS = 200;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const time = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function phase(entry: unknown): WorkflowRunPhase | undefined {
  if (!isObject(entry)) return undefined;
  const title = text(entry.title);
  return title && RUN_STATUSES.has(entry.status as WorkflowRunStatus)
    ? { title, status: entry.status as WorkflowRunStatus }
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
  return {
    id: text(entry.id) ?? `a${index + 1}`,
    label,
    ...(name ? { agent: name } : {}),
    ...(phaseTitle ? { phase: phaseTitle } : {}),
    status: entry.status as WorkflowAgentStatus,
    ...(sessionId ? { sessionId } : {}),
    ...(summary ? { summary } : {}),
  };
}

/** The run in a `workflow` call's metadata; `null` when the metadata is not a run. */
export function parseWorkflowRun(metadata: unknown): WorkflowRun | null {
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
  return {
    runId: text(metadata.runId) ?? '',
    title: text(metadata.title) ?? '',
    status: metadata.status as WorkflowRunStatus,
    phases,
    agents,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(error ? { error } : {}),
  };
}

/** True for pi's `workflow` tool, under any of its spellings, and for no other name ending in `workflow`. */
export function isWorkflowTool(name: string): boolean {
  return name.replace(/^oc[-_]/, '') === 'workflow';
}
