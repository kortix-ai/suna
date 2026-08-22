/**
 * The chat's rows: `constructTimelineRows` from the SDK, fed the web's own
 * part filter and grouping, then `reuseTimelineRows` so an unchanged row is
 * the SAME object frame after frame.
 *
 * PURE, no React. Every rule here is unit-tested in `build-chat-rows.test.ts`,
 * and the grouping is asserted equal to `segmentTurn` — the model
 * `ActivityBurst` was built on — turn for turn.
 *
 * WHY THE FILTER AND GROUPING ARE SUPPLIED HERE. The SDK deliberately ships no
 * grouping table (see `timeline.ts`, "WHY GROUPING IS INJECTED"). The web
 * already owns one: a burst is a maximal run of non-text, non-standalone
 * parts (`segment-turn.ts`), and three part kinds never reach it — the plan
 * write (the plan card owns it), an unanswered question (the composer owns
 * it), and the invisible bookkeeping parts (`isInvisibleActivityPart`). Those
 * are exactly `webIsRenderablePart` + `makeWebGroupPart`. Hidden tools
 * (`todoread`, `context_info`) are NOT dropped here: today they ride into the
 * burst and `ActivityBurst` renders them, so dropping them would change the
 * output.
 */
import { isTextPart, isToolPart, type MessageWithParts, type Part } from '@/ui';
import {
  constructTimelineRows,
  reuseTimelineRows,
  type TimelineMessageLike,
  type TimelineRow,
} from '@kortix/sdk';

import { isInvisibleActivityPart, isStandaloneActivityTool } from '../session-activity-groups';
import { isPlanWriteTool } from '../turn/plan-anchor';

// ============================================================================
// Input
// ============================================================================

/**
 * The ONE type accommodation between the opencode wire types and the SDK's
 * row input. Type-only; no runtime work.
 *
 * `tsc` rejects `constructTimelineRows(messages)` on `MessageWithParts[]` with:
 *
 *   TS2345: Argument of type 'MessageWithParts[]' is not assignable to
 *   parameter of type 'readonly TimelineMessageLike[]'. … Types of property
 *   'summary' are incompatible. Type 'boolean | undefined' is not assignable
 *   to type '{ diffs?: unknown[] } | undefined'.
 *
 * `AssistantMessage.summary?: boolean` (opencode 1.18.19) marks a compaction
 * summary; `TimelineMessageLike.info.summary?.diffs` is the per-turn diff list
 * a user message may carry. The SDK's `uniqueSummaryDiffs` reads
 * `summary?.diffs` and tolerates any non-array (returns `[]`), so a boolean
 * is safe at runtime. Widening the SDK type to `{ diffs?: unknown[] } |
 * boolean` is the proper fix and a follow-up under `packages/sdk` TDD rules.
 * Keep this the only cast site.
 */
export function toTimelineInput(
  messages: readonly MessageWithParts[],
): readonly TimelineMessageLike[] {
  return messages as unknown as readonly TimelineMessageLike[];
}

// ============================================================================
// Filter + grouping (the legacy `segments` pre-filter, then `segmentTurn`)
// ============================================================================

/**
 * Which parts get a row. Mirrors, in order: `segmentTurn`'s
 * `isInvisibleActivityPart` skip, and the `SessionTurnImpl` `segments`
 * pre-filter (plan write dropped; a `question` kept only when answered).
 *
 * The plan write (`todowrite` / `todo_write`, matched by `isPlanWriteTool`)
 * is dropped because the Easy panel's Plan card (mobile: the plan card
 * beneath the user message) is the single canonical todo surface; showing the
 * same checklist again inside a burst would just duplicate it.
 *
 * `answeredQuestionIds` is the session-wide set of question part ids that
 * render as answered (`deriveAnsweredQuestionIds` in `project-rows.ts`). It
 * includes optimistic answers, so a just-answered question is a row on the
 * frame the answer is cached — no frame where it is filtered away.
 */
export function webIsRenderablePart(part: Part, answeredQuestionIds: ReadonlySet<string>): boolean {
  if (isInvisibleActivityPart(part)) return false;
  if (isToolPart(part)) {
    if (isPlanWriteTool(part.tool)) return false;
    if (part.tool === 'question') return answeredQuestionIds.has(part.id);
  }
  return true;
}

/**
 * The coalescing key: `'burst'` for every renderable part except text (its own
 * row) and a standalone tool (its own row) — `segmentTurn`'s rule exactly.
 * `standaloneCallIds` are the calls with a pending permission, which must
 * never fold into a collapsed burst.
 */
export function makeWebGroupPart(
  standaloneCallIds: ReadonlySet<string>,
): (part: Part) => string | undefined {
  return (part) => {
    if (isTextPart(part)) return undefined;
    if (isToolPart(part)) {
      if (isStandaloneActivityTool(part.tool) || standaloneCallIds.has(part.callID)) {
        return undefined;
      }
    }
    return 'burst';
  };
}

// ============================================================================
// buildChatRows
// ============================================================================

export interface BuildChatRowsInput {
  /** `[...messages, ...queuedSyntheticMessages]` — the SAME array that feeds
   *  `groupMessagesIntoTurns`, so the rows and the turns agree on every id. */
  messages: readonly MessageWithParts[];
  /**
   * MUST be `workingTurn.workingTurnId`. The SDK's default (the last turn)
   * would mark a queued pending bubble as the active turn and hang the
   * `thinking` / `retry` rows under it.
   */
  activeUserMessageID: string | null | undefined;
  /** `sessionStatus?.type`; `undefined` reads as `'idle'`. */
  status: string | undefined;
  standaloneCallIds: ReadonlySet<string>;
  answeredQuestionIds: ReadonlySet<string>;
  /** The previous frame's rows, for `reuseTimelineRows`. */
  prev: readonly TimelineRow[] | undefined;
}

export function buildChatRows(input: BuildChatRowsInput): TimelineRow[] {
  const { answeredQuestionIds } = input;
  const next = constructTimelineRows(toTimelineInput(input.messages), {
    activeUserMessageID: input.activeUserMessageID ?? undefined,
    status: input.status ?? 'idle',
    // Reasoning renders (inside a burst, as the thought chain); the predicate
    // below decides the rest.
    showReasoning: true,
    isRenderablePart: (part) => webIsRenderablePart(part as Part, answeredQuestionIds),
    groupPart: makeWebGroupPart(input.standaloneCallIds) as (
      part: TimelineMessageLike['parts'][number],
    ) => string | undefined,
  });
  return reuseTimelineRows((input.prev ?? []) as TimelineRow[], next);
}

// ============================================================================
// Grouping rows per turn
// ============================================================================

export interface TurnRowGroup {
  userMessageID: string;
  /** The turn's rows in SDK order — its `turn-gap` (when not first) included. */
  rows: TimelineRow[];
}

/**
 * One list's group identity across frames: the rows array it last grouped and
 * the groups it handed back. Owned by the list for its lifetime (one
 * `useState(createTurnGroupCache)` per `SessionTimelineList`) and passed to
 * `groupRowsByTurn` on every render.
 */
export interface TurnGroupCache {
  rows: readonly TimelineRow[] | null;
  groups: TurnRowGroup[];
}

export function createTurnGroupCache(): TurnGroupCache {
  return { rows: null, groups: [] };
}

const groupsByRows = new WeakMap<readonly TimelineRow[], TurnRowGroup[]>();

/**
 * The rows cut per turn, in order, IDENTITY-STABLE across frames.
 *
 * With a `cache` (the list's): the same rows array returns the same groups
 * array (`buildChatRows` hands back the previous array when nothing changed;
 * React StrictMode renders twice). A new rows array is cut and then every
 * group whose turn had a group last frame with the SAME rows — same length,
 * same row objects, which `reuseTimelineRows` guarantees for an untouched
 * turn — is the previous group OBJECT; when every group is the previous one,
 * the previous ARRAY is returned too. So one appended part yields one new row
 * object (`reuseTimelineRows`), one new group object (here) and, with
 * `TurnFrame` memo'd on `group`, one frame body. Same idea, one level up.
 *
 * Without a cache (tests, one-off callers): cached on the rows array identity
 * only.
 */
export function groupRowsByTurn(
  rows: readonly TimelineRow[],
  cache?: TurnGroupCache,
): TurnRowGroup[] {
  if (!cache) {
    const cached = groupsByRows.get(rows);
    if (cached) return cached;
    const groups = cutRowsByTurn(rows);
    groupsByRows.set(rows, groups);
    return groups;
  }
  if (cache.rows === rows) return cache.groups;
  const groups = reuseTurnGroups(cache.groups, cutRowsByTurn(rows));
  cache.rows = rows;
  cache.groups = groups;
  return groups;
}

function cutRowsByTurn(rows: readonly TimelineRow[]): TurnRowGroup[] {
  const groups: TurnRowGroup[] = [];
  let current: TurnRowGroup | null = null;
  for (const row of rows) {
    if (!current || current.userMessageID !== row.userMessageID) {
      current = { userMessageID: row.userMessageID, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

/**
 * `next` with every group whose turn is unchanged (same rows by identity)
 * replaced by the PREVIOUS group object; `prev` itself when nothing changed.
 * `next` is freshly cut by the caller, so it is rewritten in place.
 */
function reuseTurnGroups(prev: TurnRowGroup[], next: TurnRowGroup[]): TurnRowGroup[] {
  if (prev.length === 0) return next;
  const byId = new Map<string, TurnRowGroup>();
  for (const group of prev)
    if (!byId.has(group.userMessageID)) byId.set(group.userMessageID, group);
  let allPrevious = prev.length === next.length;
  for (let i = 0; i < next.length; i++) {
    const group = next[i];
    const before = byId.get(group.userMessageID);
    if (before && sameRows(before.rows, group.rows)) {
      next[i] = before;
      if (allPrevious && prev[i] !== before) allPrevious = false;
    } else {
      allPrevious = false;
    }
  }
  return allPrevious ? prev : next;
}

function sameRows(a: readonly TimelineRow[], b: readonly TimelineRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ============================================================================
// Keys
// ============================================================================

/**
 * The React key of a row. A `user-message` row is keyed by the id its bubble
 * was FIRST painted under (`turnRenderKeys`, the optimistic origin, `~`
 * suffixed on a collision) so the swap to a re-minted echo id re-renders the
 * bubble instead of remounting it. Every other row keeps the SDK key.
 */
export function aliasRowKey(
  row: TimelineRow,
  renderKeyOf: (userMessageID: string) => string | undefined,
): string {
  if (row.kind !== 'user-message') return row.key;
  const alias = renderKeyOf(row.userMessageID);
  return `user-message:${alias ?? row.userMessageID}`;
}
