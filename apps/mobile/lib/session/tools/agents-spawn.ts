/**
 * Pure logic behind `agent_spawn` (web `tool/tools/agent-spawn-tool.tsx`) and
 * `session_spawn` (web `tool/tools/session-spawn-tool.tsx`).
 *
 * Strings are web's English locale (`hardcodedUi.i18nComplete`):
 * `text9577487fd26d` "Spawn agent", `text187897ce0afc` "more",
 * `text2ee7054bf895` "Worker ·", `textb7595e2a8639` "steps",
 * `textc65feb0006ea` "Worker · {value0}{value1}", `textb581fd88ea24` ": {value0}".
 */

import { cleanWorkerOutput, parseJsonFailure, type ParsedJsonFailure, type ToolPart } from '@kortix/sdk';
import { capitalizeWords } from '@kortix/shared';
import { firstMeaningfulLine, getAgentCardLabel } from '@/lib/session/tool-part-accessors';
import { childLastActivity, describeChildStep, stepsBadge } from './agents-task';

export interface AgentSpawnModel {
  title: string;
  description: string;
  verification: string;
  isRunning: boolean;
  isCompleted: boolean;
  subtitle: string | undefined;
  badge: string | undefined;
  spawnFailure: ParsedJsonFailure | null;
  cleanedOutput: string;
  /**
   * `failure` — optional verification card + `ToolOutputFallback`;
   * `card` — one result card (verification, then output or recent steps);
   * `none` — no result body.
   */
  body: 'failure' | 'card' | 'none';
  /** The last three child steps, shown when there is no worker output. */
  recentSteps: Array<{ id: string; label: string }>;
  moreSteps: number;
  moreLabel: string | undefined;
}

export function agentSpawnModel({
  status,
  input,
  output,
  childToolParts,
}: {
  status: string;
  input: Record<string, unknown>;
  output: string;
  childToolParts: readonly ToolPart[];
}): AgentSpawnModel {
  const description = getAgentCardLabel(input);
  const verification = firstMeaningfulLine(input.verification_condition, 120);
  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';
  const cleanedOutput = cleanWorkerOutput(output);
  const spawnFailure = isCompleted ? parseJsonFailure(output) : null;
  const lastActivity = childLastActivity(childToolParts);

  const body: AgentSpawnModel['body'] =
    isCompleted && spawnFailure
      ? 'failure'
      : verification || (isCompleted && (cleanedOutput || childToolParts.length > 0))
        ? 'card'
        : 'none';

  const showSteps = isCompleted && !cleanedOutput && childToolParts.length > 0;
  const moreSteps = showSteps ? Math.max(0, childToolParts.length - 3) : 0;

  return {
    title: 'Spawn agent',
    description,
    verification,
    isRunning,
    isCompleted,
    subtitle: isRunning ? (lastActivity ?? description) : spawnFailure ? 'failed' : description || undefined,
    badge: stepsBadge(status, childToolParts.length),
    spawnFailure,
    cleanedOutput,
    body,
    recentSteps: showSteps
      ? childToolParts.slice(-3).map((tp) => ({ id: tp.id, label: describeChildStep(tp) }))
      : [],
    moreSteps,
    moreLabel: moreSteps > 0 ? `+${moreSteps} more` : undefined,
  };
}

export interface SessionSpawnModel {
  agentName: string;
  label: string;
  /** Web: `Worker · {agentName}`. */
  titleLabel: string;
  subtitle: string | undefined;
  isRunning: boolean;
  isCompleted: boolean;
  /** `N steps` once the call settles with steps. */
  stepsLabel: string | undefined;
  sessionTitle: string;
}

export function sessionSpawnModel({
  status,
  input,
  childToolParts,
}: {
  status: string;
  input: Record<string, unknown>;
  childToolParts: readonly ToolPart[];
}): SessionSpawnModel {
  const agentName = capitalizeWords((input.agent as string) || 'kortix');
  const description = (input.description as string) || '';
  const projectName = (input.project as string) || '';
  const fullPrompt = (input.prompt as string) || '';
  const label = description || projectName || fullPrompt.split('\n')[0]?.slice(0, 80) || '';
  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';
  const lastActivity = childLastActivity(childToolParts);

  return {
    agentName,
    label,
    titleLabel: `Worker · ${agentName}`,
    subtitle: isRunning ? (lastActivity ?? label) : label || undefined,
    isRunning,
    isCompleted,
    stepsLabel: isCompleted && childToolParts.length > 0 ? `${childToolParts.length} steps` : undefined,
    sessionTitle: `Worker · ${agentName}${label ? `: ${label}` : ''}`,
  };
}
