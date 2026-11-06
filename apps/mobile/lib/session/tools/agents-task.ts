/**
 * Pure logic behind the `task` row (web `tool/tools/task-tool.tsx`) and the
 * child-session step helpers every sub-agent row shares.
 *
 * Strings are web's English locale (`hardcodedUi.i18nComplete`):
 * `text9471197a871a` "Agent · {value0}", `text7decbfdbacee`
 * "Agent · {value0}{value1}", `textb581fd88ea24` ": {value0}".
 */

import { getToolInfo, type ProjectSession, type ToolCallBlock } from '@kortix/sdk';
import { firstMeaningfulLine, partInput } from '@/lib/session/tool-part-accessors';
import { sessionDisplayStatus, type SessionDisplayStatus } from '@/lib/session/session-list';


/** "Title · subtitle" for one child step (web `info.title + (info.subtitle ? ' · ' + … : '')`). */
export function describeChildStep(call: ToolCallBlock): string {
  const info = getToolInfo(call.name, partInput(call) as Record<string, any>);
  return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
}

/** The sub-agent's latest step, or `null` before it has one. */
export function childLastActivity(calls: readonly ToolCallBlock[]): string | null {
  if (calls.length === 0) return null;
  return describeChildStep(calls[calls.length - 1]);
}

/** Web badge: a settled call counts its steps. */
export function stepsBadge(status: string, count: number): string | undefined {
  return status === 'completed' && count > 0 ? `${count} steps` : undefined;
}

export interface TaskRowModel {
  subagentType: string;
  description: string;
  title: string;
  subtitle: string | undefined;
  badge: string | undefined;
  /** The row is a disclosure whose body is the sub-agent's steps. */
  hasInlineSteps: boolean;
  /** No steps in memory but a child session exists: the row press opens it. */
  rowOpensSession: boolean;
  /** The "View" action on the trigger (web `FullViewAction`). */
  showFullViewAction: boolean;
  /** Web `SubSessionModal` title. */
  sessionTitle: string;
}

export function taskRowModel({
  status,
  input,
  childSessionId,
  childCalls,
}: {
  status: string;
  input: Record<string, unknown>;
  childSessionId?: string;
  childCalls: readonly ToolCallBlock[];
}): TaskRowModel {
  const subagentType = (input.subagent_type as string) || 'general';
  const description =
    (input.description as string) || firstMeaningfulLine(input.prompt) || firstMeaningfulLine(input.title, 80);
  const isRunning = status === 'running' || status === 'pending';
  const lastActivity = childLastActivity(childCalls);
  const hasInlineSteps = Boolean(childSessionId) && childCalls.length > 0;
  const title = `Agent · ${subagentType}`;

  return {
    subagentType,
    description,
    title,
    subtitle: isRunning ? (lastActivity ?? description) : description || undefined,
    badge: stepsBadge(status, childCalls.length),
    hasInlineSteps,
    rowOpensSession: Boolean(childSessionId) && !hasInlineSteps,
    showFullViewAction: Boolean(childSessionId),
    sessionTitle: `${title}${description ? `: ${description}` : ''}`,
  };
}

/** The state a sub-agent call card names (web `tools.agent.state`). */
export type AgentCallState = 'working' | 'needs_input' | 'done' | 'failed' | 'stopped';

export const AGENT_CALL_LABEL: Record<AgentCallState, string> = {
  working: 'Working',
  needs_input: 'Needs you',
  done: 'Done',
  failed: 'Didn’t finish',
  stopped: 'Stopped',
};

/** The session-list mark each call state draws. */
export const AGENT_CALL_GLYPH: Record<AgentCallState, SessionDisplayStatus> = {
  working: 'running',
  needs_input: 'needs-you',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/**
 * How a sub-agent call is doing. The child session's own display status wins;
 * then this device's live status for it; then the call's own status. A
 * background hand-off returns at once, so its call is "completed" while the
 * child still works: it reads working until the child's last reply completed.
 */
export function agentCallState({
  status,
  hasError,
  background,
  childDisplay,
  childLiveType,
  childReplied,
}: {
  status: string;
  hasError: boolean;
  background: boolean;
  childDisplay?: SessionDisplayStatus | null;
  childLiveType?: string | null;
  childReplied: boolean;
}): AgentCallState {
  if (hasError) return 'failed';
  if (childDisplay === 'needs-you') return 'needs_input';
  if (childDisplay === 'failed') return 'failed';
  if (childDisplay === 'stopped') return 'stopped';
  if (childDisplay === 'running' || childDisplay === 'starting') return 'working';
  if (childDisplay === 'done') return 'done';
  if (childLiveType === 'busy' || childLiveType === 'retry') return 'working';
  if (status === 'running' || status === 'pending') return 'working';
  if (background) return childLiveType === 'idle' || childReplied ? 'done' : 'working';
  return 'done';
}

/**
 * A child session's display status for an agent surface. A session whose computer could
 * not start is `failed`, even while its first prompt still waits to be delivered: the API
 * then reports it as working, and the card would read Working for an agent that never ran.
 */
export function agentSessionDisplay(row: ProjectSession): SessionDisplayStatus {
  return row.status === 'failed' ? 'failed' : sessionDisplayStatus(row);
}
