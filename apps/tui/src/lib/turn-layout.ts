/**
 * Pure transcript layout rules. No React, no renderer, no SDK client — only
 * the `ClassifiedPart` shapes `classifyTurn` returns, so every rule here is a
 * unit test instead of a screenshot.
 *
 * Three jobs:
 *  1. Decide which classified parts render at all, and collapse a run of
 *     consecutive tool parts into one "Completed N steps" row (the web
 *     transcript's activity burst, reduced to what a terminal row can carry).
 *  2. Turn an SDK `DiffLine[]` into the single unified-diff string OpenTUI's
 *     `<diff>` renderable parses.
 *  3. The small text rules a terminal needs: tail N lines, truncate to N
 *     columns, relative time.
 *
 * `formatElapsed` is NOT redeclared here — `lib/transcript-view.ts` owns it.
 */

import type { ClassifiedPart, ClassifiedToolPart, DiffLine, MessageWithParts } from '@kortix/sdk';

// ============================================================================
// Rows
// ============================================================================

/** A run shorter than this renders as individual cards. "Completed 1 step" is
 *  a door in front of a door: the reader opens a row to find one row. */
export const MIN_COLLAPSE_RUN = 2;

export type TurnRow =
  | { kind: 'part'; key: string; part: ClassifiedPart }
  | { kind: 'steps'; key: string; tools: ClassifiedToolPart[] };

/**
 * Does this part put anything on screen?
 *
 * `step`/`snapshot`/`agent` are bookkeeping markers with no chat-visible
 * content (the same no-op `examples/04-render-transcript.ts` and the web
 * renderers make). Filtering them BEFORE collapsing matters: a `step-start`
 * marker between two tool calls must not break the run in half.
 *
 * A synthetic text part is wire-internal (shell mode's synthetic prompt), and
 * an empty text/reasoning part is nothing at all.
 */
export function isRenderablePart(part: ClassifiedPart): boolean {
  switch (part.kind) {
    case 'step':
    case 'snapshot':
    case 'agent':
      return false;
    case 'text':
      return !part.synthetic && part.text.trim().length > 0;
    case 'reasoning':
      return part.text.trim().length > 0;
    default:
      return true;
  }
}

/** A stable key for a row. Part ids are wire ids; a steps run is keyed by its
 *  first tool so the key survives the run growing at the end while it streams. */
export function rowKey(part: ClassifiedPart): string {
  return 'id' in part ? part.id : 'unknown';
}

/**
 * Drop the invisible parts, then fold every run of `MIN_COLLAPSE_RUN`+
 * consecutive tool parts into one `steps` row.
 */
export function collapseToolRuns(parts: readonly ClassifiedPart[]): TurnRow[] {
  const visible = parts.filter(isRenderablePart);
  const rows: TurnRow[] = [];
  let run: ClassifiedToolPart[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length >= MIN_COLLAPSE_RUN) {
      rows.push({ kind: 'steps', key: `steps:${run[0]?.id}`, tools: run });
    } else {
      for (const tool of run) rows.push({ kind: 'part', key: rowKey(tool), part: tool });
    }
    run = [];
  };

  for (const part of visible) {
    if (part.kind === 'tool') {
      run.push(part);
      continue;
    }
    flush();
    rows.push({ kind: 'part', key: rowKey(part), part });
  }
  flush();
  return rows;
}

/** Row keys the reader can expand or collapse, in document order. */
export function toggleableKeys(rows: readonly TurnRow[]): string[] {
  return rows
    .filter((row) => row.kind === 'steps' || row.part.kind === 'reasoning')
    .map((row) => row.key);
}

// ============================================================================
// Steps summary
// ============================================================================

export interface StepsSummary {
  /** Tool calls in the run. */
  total: number;
  /** Calls whose normalized status is `error`. */
  failed: number;
  completed: number;
  /** True while any call is still pending or running. */
  running: boolean;
  /** 1-based position of the call that is running now, or 0. */
  runningStep: number;
  /** Title of the call that is running now, or ''. */
  runningTitle: string;
}

export function summarizeSteps(tools: readonly ClassifiedToolPart[]): StepsSummary {
  let failed = 0;
  let running = false;
  let runningStep = 0;
  let runningTitle = '';
  tools.forEach((part, index) => {
    const { status, title, name } = part.tool;
    if (status === 'error') failed += 1;
    if (status === 'running' || status === 'pending') {
      running = true;
      runningStep = index + 1;
      runningTitle = title || name;
    }
  });
  const total = tools.length;
  return { total, failed, completed: total - failed, running, runningStep, runningTitle };
}

function plural(count: number): string {
  return `${count} ${count === 1 ? 'step' : 'steps'}`;
}

/**
 * The one line the collapsed row prints.
 *
 * A running run reports no failure count: its calls are still landing, so any
 * number is a snapshot the next frame contradicts (same rule as the web
 * transcript's `burstSummaryLabel`).
 */
export function stepsLabel(summary: StepsSummary): string {
  const { total, failed, completed, running, runningStep, runningTitle } = summary;
  if (running) {
    const step = runningStep || total;
    return runningTitle ? `Working · step ${step}: ${runningTitle}` : `Working · ${plural(total)}`;
  }
  if (total === 0) return 'Worked';
  if (failed === 0) return `Completed ${plural(total)}`;
  if (completed === 0) return `${plural(total)} failed`;
  return `Completed ${completed} of ${total} steps · ${failed} failed`;
}

// ============================================================================
// Text rules
// ============================================================================

/** The last `max` lines of `text`, and how many were dropped above them. */
export function tailLines(text: string, max: number): { lines: string[]; hidden: number } {
  const all = text.replace(/\s+$/, '').split('\n');
  if (max <= 0) return { lines: [], hidden: all.length };
  if (all.length <= max) return { lines: all, hidden: 0 };
  return { lines: all.slice(all.length - max), hidden: all.length - max };
}

/** The first `max` lines of `text`, and how many were dropped below them. */
export function headLines(text: string, max: number): { lines: string[]; hidden: number } {
  const all = text.replace(/\s+$/, '').split('\n');
  if (max <= 0) return { lines: [], hidden: all.length };
  if (all.length <= max) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, max), hidden: all.length - max };
}

/** Clip one line to `width` columns, with an ellipsis when it was clipped. */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(width - 1, 0))}…`;
}

/** `now`, `12s`, `4m`, `3h`, `2d` — the age a turn header prints. */
export function formatRelativeTime(then: number, now: number = Date.now()): string {
  const seconds = Math.max(Math.floor((now - then) / 1000), 0);
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ============================================================================
// Unified diff
// ============================================================================

/**
 * `DiffLine[]` (SDK `toolViewModel`, kind `file-edit`) → one unified-diff
 * string. OpenTUI's `<diff>` takes exactly one `diff` prop and parses it with
 * the `diff` npm package, so the hunk header has to carry real counts — a
 * bare `@@ @@` is not a patch.
 */
export function toUnifiedDiff(path: string, lines: readonly DiffLine[]): string {
  const oldCount = lines.filter((line) => line.type !== 'added').length;
  const newCount = lines.filter((line) => line.type !== 'removed').length;
  const name = path || 'file';
  const body = lines.map((line) => {
    if (line.type === 'added') return `+${line.text}`;
    if (line.type === 'removed') return `-${line.text}`;
    return ` ${line.text}`;
  });
  return [
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...body,
    '',
  ].join('\n');
}

// ============================================================================
// Permission → the tool call it gates
// ============================================================================

export interface GatedToolCall {
  name: string;
  input?: Record<string, unknown>;
}

/**
 * The tool call a `PermissionRequest` is holding open.
 *
 * The request itself carries only `{messageID, callID}` plus match patterns —
 * never the arguments. An approval gate that cannot show the arguments is not
 * an approval gate (memory `approval-gate-must-show-arguments`), so the
 * transcript resolves the call out of the messages it already has.
 */
export function findToolCall(
  messages: readonly MessageWithParts[],
  tool: { messageID: string; callID: string } | undefined,
): GatedToolCall | null {
  if (!tool) return null;
  for (const message of messages) {
    if (message.info.id !== tool.messageID) continue;
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.callID !== tool.callID) continue;
      const state = part.state as { input?: Record<string, unknown> } | undefined;
      return { name: part.tool, input: state?.input };
    }
  }
  return null;
}

/** Stable, readable JSON for an approval gate. Never truncated: the whole
 *  point of the card is that the reader sees every argument. */
export function formatArguments(input: Record<string, unknown> | undefined): string[] {
  if (!input || Object.keys(input).length === 0) return [];
  try {
    return JSON.stringify(input, null, 2).split('\n');
  } catch {
    return ['<unserializable arguments>'];
  }
}

// ============================================================================
// Message order
// ============================================================================

/**
 * `session.messages` in display order, deduped, with the empty assistant
 * shells dropped — i.e. `groupMessagesIntoTurns` flattened back to a list.
 * Grouping is the SDK's ordering rule; re-sorting here would be a second,
 * divergent copy of it.
 */
export function orderedMessages(
  turns: readonly { userMessage: MessageWithParts; assistantMessages: MessageWithParts[] }[],
): MessageWithParts[] {
  const flat: MessageWithParts[] = [];
  for (const turn of turns) {
    flat.push(turn.userMessage);
    for (const assistant of turn.assistantMessages) flat.push(assistant);
  }
  return flat;
}
