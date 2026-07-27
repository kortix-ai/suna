/**
 * Turn parts → renderable activity items.
 *
 * This is the layer that decides what the transcript SHOWS. It is pure, so the
 * decisions are testable and the three chat variants can share one brain and
 * differ only in paint.
 *
 * ## The bug this file was extracted to fix
 *
 * Grouping lived inline in `session-chat.tsx` and split a run of tool calls on
 * ANY part it did not recognise. The runtime emits `step-start` / `step-finish`
 * bookkeeping parts around every model round-trip, and those parts render
 * nothing — so twelve consecutive `bash` calls arrived as
 * `step-start, tool, step-finish, step-start, tool, …` and every single group
 * boundary was a false one. The result was twelve raw `$ cd /workspace && …`
 * rows where the code intended one "Ran 12 commands" line.
 *
 * `isStructuralPart` is the fix: parts that paint nothing never break a run.
 */

import {
  isNoGroupActivityTool,
  normalizeActivityToolName,
} from '@/features/session/session-activity-groups';
import type { MessageWithParts, Part, ReasoningPart, ToolPart } from '@/ui';
import { isReasoningPart, isTextPart, isToolPart, shouldShowToolPart } from '@/ui';
import { type ActivityCounts, emptyActivityCounts } from './humanize';

// ============================================================================
// Structural parts — render nothing, must never split a run
// ============================================================================

/**
 * Part types that carry no user-visible content of their own.
 *
 * `step-start` / `step-finish` are the important entries: they wrap every model
 * round-trip, so treating them as content is what fragmented every tool group
 * in the transcript. `snapshot` / `patch` are internal VCS bookkeeping.
 * `agent` and `retry` paint elsewhere (the agent chip, the retry banner), never
 * in the step list.
 */
const STRUCTURAL_PART_TYPES = new Set([
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'agent',
  'retry',
]);

/** True when a part paints nothing in the activity list and must therefore be
 *  transparent to grouping. */
export function isStructuralPart(part: { type?: string; text?: string }): boolean {
  if (part.type && STRUCTURAL_PART_TYPES.has(part.type)) return true;
  // A blank text part is a streaming artefact, not a paragraph break.
  if (part.type === 'text' && !part.text?.trim()) return true;
  if (part.type === 'reasoning' && !part.text?.trim()) return true;
  return false;
}

// ============================================================================
// Tool categories
// ============================================================================

export type ActivityKind = keyof ActivityCounts;

const KIND_BY_TOOL: Record<string, ActivityKind> = {
  bash: 'shell',
  read: 'read',
  write: 'write',
  edit: 'edit',
  apply_patch: 'edit',
  multiedit: 'edit',
  glob: 'search',
  grep: 'search',
  list: 'search',
  web_search: 'web',
  websearch: 'web',
  webfetch: 'web',
  web_fetch: 'web',
  scrape: 'web',
  scrape_webpage: 'web',
};

export function activityKindForTool(toolName: string | undefined): ActivityKind {
  return KIND_BY_TOOL[normalizeActivityToolName(toolName)] ?? 'other';
}

/**
 * Tools whose output IS the deliverable — a rendered preview, an image, a
 * generated document. Folding one of these into a collapsed group hides the
 * thing the user actually asked for, so they always stand alone at full size.
 */
export function isDeliverableTool(toolName: string | undefined): boolean {
  const n = normalizeActivityToolName(toolName);
  if (isNoGroupActivityTool(toolName)) return true;
  return (
    n === 'image_gen' ||
    n === 'video_gen' ||
    n === 'presentation_gen' ||
    n === 'question' ||
    n === 'task' ||
    n === 'todowrite'
  );
}

/**
 * Tools that render their own dedicated UI and are handled by the turn body
 * rather than the activity list (todos, questions, sub-agent cards).
 */
export function isSelfRenderingTool(toolName: string | undefined): boolean {
  const n = normalizeActivityToolName(toolName);
  return n === 'todowrite' || n === 'todoread' || n === 'question' || n === 'task';
}

// ============================================================================
// Items
// ============================================================================

export interface ActivityEntry {
  part: ToolPart;
  message: MessageWithParts;
}

export type ActivityItem =
  | { type: 'reasoning'; key: string; parts: ReasoningPart[] }
  /** 2+ consecutive tool calls folded behind one summary line. */
  | {
      type: 'group';
      key: string;
      /** The single kind when the run is homogeneous, else `'other'`. */
      kind: ActivityKind;
      counts: ActivityCounts;
      entries: ActivityEntry[];
    }
  | { type: 'tool'; key: string; entry: ActivityEntry }
  /** A `show` output, generated image, deck — never folded. */
  | { type: 'deliverable'; key: string; entry: ActivityEntry }
  /** Assistant prose between bursts of work. */
  | { type: 'text'; key: string; part: Part; message: MessageWithParts }
  /** Anything the activity list does not own — the turn body renders it. */
  | { type: 'passthrough'; key: string; part: Part; message: MessageWithParts };

export interface BuildActivityOptions {
  /**
   * How aggressively to fold.
   *   `'detailed'` — group only runs of the SAME kind (today's behaviour, fixed).
   *   `'simple'`   — group ANY adjacent run of background work, mixed kinds
   *                  included, so a read→bash→write→bash sequence is one line.
   */
  density?: 'simple' | 'detailed';
  /** Tool callIDs with a pending permission prompt — never fold those, the
   *  user has to see what they are approving. */
  lockedCallIds?: ReadonlySet<string>;
  /** Parts the turn body has already claimed (e.g. hidden behind a prompt). */
  isHidden?: (part: ToolPart, messageId: string) => boolean;
}

const MIN_GROUP_SIZE = 2;

/**
 * Fold a turn's parts into the list the transcript renders.
 *
 * Guarantees, all covered by `activity-model.test.ts`:
 *  - structural parts never split a run
 *  - deliverables are never swallowed by a group
 *  - a locked (permission-pending) tool is never swallowed by a group
 *  - a run of one stays a single row; `MIN_GROUP_SIZE`+ folds
 */
export function buildActivityItems(
  parts: ReadonlyArray<{ part: Part; message: MessageWithParts }>,
  options: BuildActivityOptions = {},
): ActivityItem[] {
  const { density = 'detailed', lockedCallIds, isHidden } = options;

  const items: ActivityItem[] = [];
  let pendingReasoning: ReasoningPart[] = [];
  let pendingTools: ActivityEntry[] = [];
  let pendingKey: string | null = null;

  const flushReasoning = () => {
    if (pendingReasoning.length === 0) return;
    items.push({
      type: 'reasoning',
      key: `reasoning-${pendingReasoning[0].id ?? items.length}`,
      parts: pendingReasoning,
    });
    pendingReasoning = [];
  };

  const flushTools = () => {
    if (pendingTools.length === 0) {
      pendingKey = null;
      return;
    }
    if (pendingTools.length < MIN_GROUP_SIZE) {
      for (const entry of pendingTools) {
        items.push({ type: 'tool', key: `tool-${entry.part.id}`, entry });
      }
    } else {
      const counts = emptyActivityCounts();
      const kinds = new Set<ActivityKind>();
      for (const entry of pendingTools) {
        const kind = activityKindForTool(entry.part.tool);
        counts[kind] += 1;
        kinds.add(kind);
      }
      items.push({
        type: 'group',
        key: `group-${pendingTools[0].part.id}`,
        kind: kinds.size === 1 ? [...kinds][0] : 'other',
        counts,
        entries: pendingTools,
      });
    }
    pendingTools = [];
    pendingKey = null;
  };

  for (const { part, message } of parts) {
    // Structural parts are transparent: they neither render nor break a run.
    // This single line is the whole grouping regression fix.
    if (isStructuralPart(part)) continue;

    if (isReasoningPart(part)) {
      flushTools();
      pendingReasoning.push(part);
      continue;
    }

    flushReasoning();

    if (isToolPart(part)) {
      const tp = part as ToolPart;

      if (!shouldShowToolPart(tp)) continue;
      if (isHidden?.(tp, message.info.id)) continue;

      if (isSelfRenderingTool(tp.tool)) {
        flushTools();
        items.push({ type: 'passthrough', key: `pass-${tp.id}`, part, message });
        continue;
      }

      if (isDeliverableTool(tp.tool)) {
        flushTools();
        items.push({ type: 'deliverable', key: `deliv-${tp.id}`, entry: { part: tp, message } });
        continue;
      }

      // A tool awaiting approval must be legible on its own.
      if (lockedCallIds?.has(tp.callID)) {
        flushTools();
        items.push({ type: 'tool', key: `tool-${tp.id}`, entry: { part: tp, message } });
        continue;
      }

      const kind = activityKindForTool(tp.tool);
      // 'simple' folds everything adjacent into one run; 'detailed' only folds
      // like with like.
      const groupKey = density === 'simple' ? '*' : normalizeActivityToolName(tp.tool);
      if (pendingKey !== null && pendingKey !== groupKey) flushTools();
      pendingKey = groupKey;
      pendingTools.push({ part: tp, message });
      void kind;
      continue;
    }

    flushTools();

    if (isTextPart(part) && part.text?.trim()) {
      items.push({ type: 'text', key: `text-${part.id}`, part, message });
      continue;
    }

    items.push({ type: 'passthrough', key: `pass-${part.id ?? items.length}`, part, message });
  }

  flushReasoning();
  flushTools();

  return items;
}

// ============================================================================
// Derived summaries
// ============================================================================

export interface ActivitySummary {
  /** Every tool call in the turn, folded or not. */
  totalSteps: number;
  counts: ActivityCounts;
  /** Wall-clock across the whole run, ms. 0 when unknown. */
  durationMs: number;
  running: boolean;
}

function partTime(part: ToolPart): { start?: number; end?: number } {
  const time = (part.state as { time?: { start?: number; end?: number } } | undefined)?.time;
  return { start: time?.start, end: time?.end };
}

export function isPartRunning(part: ToolPart): boolean {
  const status = (part.state as { status?: string } | undefined)?.status;
  return status === 'running' || status === 'pending';
}

/** Roll a list of entries up into the numbers a summary line needs. */
export function summarizeEntries(entries: ReadonlyArray<ActivityEntry>): ActivitySummary {
  const counts = emptyActivityCounts();
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  let running = false;

  for (const { part } of entries) {
    counts[activityKindForTool(part.tool)] += 1;
    const { start, end } = partTime(part);
    if (typeof start === 'number' && start < earliest) earliest = start;
    if (typeof end === 'number' && end > latest) latest = end;
    if (isPartRunning(part)) running = true;
  }

  return {
    totalSteps: entries.length,
    counts,
    durationMs: latest > earliest ? latest - earliest : 0,
    running,
  };
}

/** Roll a whole item list up — used by the per-turn "N steps" pill. */
export function summarizeItems(items: ReadonlyArray<ActivityItem>): ActivitySummary {
  const entries: ActivityEntry[] = [];
  for (const item of items) {
    if (item.type === 'group') entries.push(...item.entries);
    else if (item.type === 'tool' || item.type === 'deliverable') entries.push(item.entry);
  }
  return summarizeEntries(entries);
}

/** `4s`, `1m 12s`, or '' below a second — durations under a second are noise. */
export function formatActivityDuration(ms: number): string {
  if (!ms || ms < 1000) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// ============================================================================
// Narrative fold
// ============================================================================

/** One child of a run, in the order it actually happened. */
export type NarrativeRunChild =
  | { kind: 'reasoning'; key: string; parts: ReasoningPart[] }
  | { kind: 'step'; key: string; entry: ActivityEntry };

export interface NarrativeRun {
  /** Key of the run's FIRST item — the slot that paints the work line, so the
   *  line keeps its place in the narrative. */
  key: string;
  /** Reasoning and steps INTERLEAVED, in wire order. The runtime emits
   *  `step-start → reasoning → tool → step-finish`, so a run genuinely reads
   *  "thought, did, thought, did". Collecting all reasoning into one block and
   *  all steps into another — which this used to do — showed the model's
   *  thinking detached from the work it produced. */
  children: NarrativeRunChild[];
  /** Steps only, for the summary line (count, duration, liveness). */
  entries: ActivityEntry[];
  /** @deprecated Use `children` to render in order. Kept for the summary. */
  reasoningParts: ReasoningPart[];
}

export interface NarrativeFold {
  /** Every item key absorbed into some run. */
  foldedKeys: Set<string>;
  /** Contiguous runs of machinery, in order. */
  runs: NarrativeRun[];
  /** Run keyed by the slot that should paint it. */
  runByKey: Map<string, NarrativeRun>;
}

/**
 * Decide what Narrative mode hides, and WHERE.
 *
 * Folds each CONTIGUOUS run of machinery separately rather than collapsing a
 * whole turn into one line. That distinction is the difference between reading
 * a conversation and reading a report: an agent that works, explains, works
 * again and explains again must render as
 *
 *     [work] "here's what I found" [work] "here's the plan" [work]
 *
 * Collapsing per-turn instead produced [work] followed by every paragraph in a
 * row, which destroyed the back-and-forth — prose all bunched at the bottom,
 * disconnected from the work that produced it.
 *
 * Two things stay OUT of a run, and both are correctness rather than taste: a
 * FAILED step (a reader must see it without expanding) and a step waiting on a
 * PERMISSION prompt (a reader must see what they are approving). Either one
 * also ENDS the current run, so the line above it summarises only the work that
 * actually preceded it.
 *
 * A group is decided as a whole before any of it is collected — collecting
 * eagerly and bailing later would leave the same call rendered twice, once
 * inside the work line and once inside the group that still had to render.
 */
export function partitionForNarrative(
  items: ReadonlyArray<ActivityItem>,
  lockedCallIds?: ReadonlySet<string>,
): NarrativeFold {
  const foldedKeys = new Set<string>();
  const runs: NarrativeRun[] = [];
  const runByKey = new Map<string, NarrativeRun>();
  let current: NarrativeRun | null = null;

  const canFold = (entry: ActivityEntry) => {
    const status = (entry.part.state as { status?: string } | undefined)?.status;
    if (status === 'error') return false;
    return !lockedCallIds?.has(entry.part.callID);
  };

  const open = (key: string) => {
    if (current) return current;
    current = { key, children: [], entries: [], reasoningParts: [] };
    runs.push(current);
    runByKey.set(key, current);
    return current;
  };
  /** Anything that is not foldable machinery breaks the run — prose, a
   *  deliverable, a failure, an approval. The next machinery starts a new one. */
  const close = () => {
    current = null;
  };

  for (const item of items) {
    let folded = false;

    if (item.type === 'group') {
      if (item.entries.every(canFold)) {
        const run = open(item.key);
        run.entries.push(...item.entries);
        for (const entry of item.entries) {
          run.children.push({ kind: 'step', key: entry.part.id, entry });
        }
        folded = true;
      }
    } else if (item.type === 'tool') {
      if (canFold(item.entry)) {
        const run = open(item.key);
        run.entries.push(item.entry);
        run.children.push({ kind: 'step', key: item.entry.part.id, entry: item.entry });
        folded = true;
      }
    } else if (item.type === 'reasoning') {
      const run = open(item.key);
      run.reasoningParts.push(...item.parts);
      run.children.push({ kind: 'reasoning', key: item.key, parts: item.parts });
      folded = true;
    }

    if (folded) foldedKeys.add(item.key);
    else close();
  }

  return { foldedKeys, runs, runByKey };
}

/**
 * Is THIS run still live?
 *
 * The turn-level "still streaming" flag is not the answer. Applying it to every
 * run made a page of finished work all claim the same live status — four rows
 * of "Making edits… · N steps", each spinning, for runs that had completed
 * minutes earlier. A run is live only when one of its own steps is in flight,
 * or when it is the last run of a turn that is still going and will therefore
 * receive the next step.
 */
export function isRunLive({
  hasRunningStep,
  turnWorking,
  isLatest,
}: {
  hasRunningStep: boolean;
  turnWorking: boolean;
  isLatest: boolean;
}): boolean {
  return hasRunningStep || (turnWorking && isLatest);
}
