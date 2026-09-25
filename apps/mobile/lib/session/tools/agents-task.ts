/**
 * Pure logic behind the `task` row (web `tool/tools/task-tool.tsx`) and the
 * child-session step helpers every sub-agent row shares.
 *
 * Strings are web's English locale (`hardcodedUi.i18nComplete`):
 * `text9471197a871a` "Agent · {value0}", `text7decbfdbacee`
 * "Agent · {value0}{value1}", `textb581fd88ea24` ": {value0}".
 */

import { getChildSessionToolParts, getToolInfo, type ToolPart } from '@kortix/sdk';
import { firstMeaningfulLine, partInput } from '@/lib/session/tool-part-accessors';

type MessageWithPartsLike = Parameters<typeof getChildSessionToolParts>[0][number];

const NO_PARTS: ToolPart[] = [];

/** A child session's visible tool parts, in order (web `getChildSessionToolParts`). */
export function childSessionToolParts(messages: readonly unknown[] | undefined): ToolPart[] {
  if (!messages || messages.length === 0) return NO_PARTS;
  return getChildSessionToolParts(messages as readonly MessageWithPartsLike[]) as unknown as ToolPart[];
}

/** "Title · subtitle" for one child step (web `info.title + (info.subtitle ? ' · ' + … : '')`). */
export function describeChildStep(part: ToolPart): string {
  const info = getToolInfo(part.tool, partInput(part) as Record<string, any>);
  return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
}

/** The sub-agent's latest step, or `null` before it has one. */
export function childLastActivity(parts: readonly ToolPart[]): string | null {
  if (parts.length === 0) return null;
  return describeChildStep(parts[parts.length - 1]);
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
  childToolParts,
}: {
  status: string;
  input: Record<string, unknown>;
  childSessionId?: string;
  childToolParts: readonly ToolPart[];
}): TaskRowModel {
  const subagentType = (input.subagent_type as string) || 'general';
  const description =
    (input.description as string) || firstMeaningfulLine(input.prompt) || firstMeaningfulLine(input.title, 80);
  const isRunning = status === 'running' || status === 'pending';
  const lastActivity = childLastActivity(childToolParts);
  const hasInlineSteps = Boolean(childSessionId) && childToolParts.length > 0;
  const title = `Agent · ${subagentType}`;

  return {
    subagentType,
    description,
    title,
    subtitle: isRunning ? (lastActivity ?? description) : description || undefined,
    badge: stepsBadge(status, childToolParts.length),
    hasInlineSteps,
    rowOpensSession: Boolean(childSessionId) && !hasInlineSteps,
    showFullViewAction: Boolean(childSessionId),
    sessionTitle: `${title}${description ? `: ${description}` : ''}`,
  };
}
