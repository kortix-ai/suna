/**
 * Timeline rows — the flat, ordered, virtualizer-ready projection of a
 * transcript, plus an identity-preserving reuse pass.
 *
 * PURE AND FRAMEWORK-FREE. This module imports only `./types`, `./parts`,
 * `./grouping` and `./errors`, all `isomorphic-core`. It reads no global —
 * no `process.env`, no `window`, no `Date.now()`, no `Math.random()` — so the
 * same input always produces the same rows on every host. A clock read here
 * would make the output non-deterministic and every row non-reusable.
 *
 * WHY ROWS HOLD IDS AND NEVER PART CONTENT. `assistant-part` carries only
 * `(messageID, partID)` refs. A text part whose body grows while it streams
 * keeps its ids, so its row is unchanged, so `reuseTimelineRows` hands back
 * the PREVIOUS object and React skips the subtree. The consumer reads the live
 * body out of the sync store by ref. The only value-bearing fields in the whole
 * union are `error.text` and `diff-summary.diffs` (projected stats only — never
 * `before` / `after` / `patch`), and both are compared by value. Adding a
 * content field to a row would make reuse either wrong (id-only compare masks
 * the change) or expensive (blob compare per row per frame). Do not add one.
 *
 * WHY GROUPING IS INJECTED RATHER THAN TABLED. OpenCode hardcodes a
 * `CONTEXT_GROUP_TOOLS = {read, glob, grep, list}` table. `apps/web` already
 * owns a richer, tested grouping model — `features/session/turn/segment-turn.ts`,
 * `merge-steps.ts`, `group-steps.ts` — and `merge-steps.ts` documents exactly
 * why two grouping implementations that must agree forever is a trap. So
 * grouping enters through `options.groupPart`; the SDK ships no table. The
 * default returns `undefined`, i.e. one row per renderable part.
 */

import { getPartText, isCompactionPart, isReasoningPart, isToolPart, shouldShowToolPart } from './parts';
import { groupMessagesIntoTurns } from './grouping';
import { unwrapError } from './errors';
import type { MessageInfoLike, MessageWithPartsLike, PartLike, ToolPartLike, TurnLike } from './types';

// ============================================================================
// The abort literal
// ============================================================================

/**
 * The `info.error.name` OpenCode stamps on a message the user interrupted.
 *
 * It is a wire string, not a typed constant in this repo, so it lives here once
 * and is asserted in `timeline.test.ts`. An upstream rename would otherwise
 * silently turn every abort into an `error` row. Re-check on each
 * `@opencode-ai/sdk` bump.
 */
export const MESSAGE_ABORTED_ERROR_NAME = 'MessageAbortedError';

// ============================================================================
// Row model
// ============================================================================

/** A stable reference to one part, by the ids that identify it on the wire. */
export interface TimelinePartRef {
  messageID: string;
  partID: string;
}

/**
 * What one `assistant-part` row renders: either a single part, or a run of
 * consecutive parts `options.groupPart` coalesced into one context group.
 */
export type TimelinePartGroup =
  | { key: string; type: 'part'; ref: TimelinePartRef }
  | { key: string; type: 'context'; refs: TimelinePartRef[] };

/**
 * One file's change counts, PROJECTED from `userMessage.info.summary.diffs`.
 *
 * The wire entry also carries whole-file contents (`before`/`after` on v1
 * `FileDiff`) or a `patch` (v2 `SnapshotFileDiff`). Those are deliberately
 * dropped: storing them would put megabytes on the row model and make row
 * equality a blob compare.
 */
export interface TimelineDiffStat {
  file: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

/** Vertical space before a turn. Never emitted for the first turn. */
export interface TimelineTurnGapRow {
  kind: 'turn-gap';
  key: string;
  userMessageID: string;
}

/** The user's prompt. Exactly one per turn, unconditional. */
export interface TimelineUserMessageRow {
  kind: 'user-message';
  key: string;
  userMessageID: string;
}

/** A labelled rule inside a turn: a context compaction, or an interruption. */
export interface TimelineTurnDividerRow {
  kind: 'turn-divider';
  key: string;
  userMessageID: string;
  label: 'compaction' | 'interrupted';
}

/** One renderable part, or one coalesced context run. */
export interface TimelineAssistantPartRow {
  kind: 'assistant-part';
  key: string;
  userMessageID: string;
  group: TimelinePartGroup;
  /** `true` when a part row already precedes this one in the same turn, so the
   *  first part row can drop its top padding. The interrupted divider does not
   *  advance the counter. */
  previousAssistantPart: boolean;
}

/** The pre-first-token placeholder on the active, busy turn. */
export interface TimelineThinkingRow {
  kind: 'thinking';
  key: string;
  userMessageID: string;
}

/**
 * The backoff notice on the active turn.
 *
 * Attempt and backoff detail deliberately do NOT live on the row: they belong
 * to session status, not per-turn data, and `getRetryInfo(status)` in
 * `core/turns/state.ts` already returns them. A field-free row stays reusable
 * across attempts.
 */
export interface TimelineRetryRow {
  kind: 'retry';
  key: string;
  userMessageID: string;
}

/** The per-file change summary for a settled turn. */
export interface TimelineDiffSummaryRow {
  kind: 'diff-summary';
  key: string;
  userMessageID: string;
  diffs: readonly TimelineDiffStat[];
}

/** The turn's failure. An abort is NOT an error — it is the interrupted divider. */
export interface TimelineErrorRow {
  kind: 'error';
  key: string;
  userMessageID: string;
  text: string;
}

/**
 * One rendered row of a transcript.
 *
 * Discriminated on `kind`, never on `type` — `type` is already the part
 * discriminant and the two must never be confused. `key` is PRECOMPUTED, not a
 * `key(row)` function: a list renderer needs the string on every frame for the
 * map build, the lookup and the virtualizer, and recomputing it four times per
 * row per frame is four template-string allocations for no gain.
 *
 * NOT PORTED: OpenCode's `CommentStrip`. Kortix has no `MessageComment`
 * producer, so it would be a row kind nothing can emit. Its slot in the
 * emission order — between `turn-gap` and `user-message` — is reserved.
 */
export type TimelineRow =
  | TimelineTurnGapRow
  | TimelineUserMessageRow
  | TimelineTurnDividerRow
  | TimelineAssistantPartRow
  | TimelineThinkingRow
  | TimelineRetryRow
  | TimelineDiffSummaryRow
  | TimelineErrorRow;

/** Every `TimelineRow['kind']` literal. */
export type TimelineRowKind = TimelineRow['kind'];

// ============================================================================
// Input protocol
// ============================================================================

/**
 * The message shape `constructTimelineRows` reads.
 *
 * A superset of `MessageWithPartsLike`: it additionally knows about the
 * optional per-message `summary.diffs` that feeds the `diff-summary` row. Every
 * `MessageWithPartsLike` satisfies it, because `summary` is optional.
 */
export interface TimelineMessageLike extends MessageWithPartsLike {
  info: MessageInfoLike & { summary?: { diffs?: unknown[] } };
}

/**
 * A part that carries its own wire id.
 *
 * Every real wire part declares `id: string` (`TextPart`, `ReasoningPart`,
 * `ToolPart`, … in `@opencode-ai/sdk@1.18.19`). `PartLike` guarantees only
 * `{ type }`, so a host fixture or an optimistic local part may lack it. See
 * `options.getPartId` for the fallback and its cost.
 */
export interface TimelinePartLike extends PartLike {
  id: string;
}

export interface ConstructTimelineRowsOptions<M extends TimelineMessageLike = TimelineMessageLike> {
  /**
   * The turn that currently owns the runtime. Only that turn can emit
   * `thinking` or `retry`. Defaults to the LAST turn.
   */
  activeUserMessageID?: string;
  /** The session's status. Defaults to `'idle'`. */
  status?: 'idle' | 'busy' | 'retry' | (string & {});
  /** Render `reasoning` parts, and suppress `thinking` once a part exists. */
  showReasoning?: boolean;
  /**
   * Which parts get a row. Runs BEFORE grouping, so a hidden tool never
   * produces or splits a group.
   *
   * Default: drop tool parts failing `shouldShowToolPart()`; drop `text` parts
   * that are empty after trim; drop `reasoning` parts unless `showReasoning`;
   * keep everything else.
   */
  isRenderablePart?: (part: PartLike, message: M) => boolean;
  /**
   * Coalescing key. Consecutive renderable parts returning the same
   * non-`undefined` id become one `context` group. Default: `() => undefined`,
   * i.e. one row per part.
   */
  groupPart?: (part: PartLike, message: M) => string | undefined;
  /**
   * Part identity. Default: `part.id` when it is a non-empty string, else the
   * POSITIONAL fallback `` `${message.info.id}:#${index}` ``.
   *
   * The fallback is best-effort, never the intended path: it renames every
   * following row when a part is inserted ahead of it, which is the scroll-jump
   * and remount the key model exists to prevent. Override this when your parts
   * have no wire id.
   */
  getPartId?: (part: PartLike, message: M, index: number) => string;
}

// ============================================================================
// Defaults
// ============================================================================

function defaultIsRenderablePart(part: PartLike, showReasoning: boolean): boolean {
  if (isToolPart(part)) return shouldShowToolPart(part as PartLike as ToolPartLike);
  if (isReasoningPart(part)) return showReasoning;
  if (part.type === 'text') return (getPartText(part) ?? '').trim().length > 0;
  return true;
}

function defaultGetPartId(part: PartLike, messageID: string, index: number): string {
  const raw = (part as Partial<TimelinePartLike>).id;
  return typeof raw === 'string' && raw.length > 0 ? raw : `${messageID}:#${index}`;
}

// ============================================================================
// Turn-level derivations
// ============================================================================

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { name?: unknown }).name === MESSAGE_ABORTED_ERROR_NAME;
}

/**
 * Deduplicate `summary.diffs` by `file`, last write wins, and project away
 * every content-bearing field.
 *
 * Ported from OpenCode's `uniqueSummaryDiffs`: walk backwards so the LAST entry
 * for a file survives, then reverse to restore the surviving entries' order.
 * Tolerates both wire shapes — v1 `FileDiff` (`file` required, plus
 * `before`/`after`) and v2 `SnapshotFileDiff` (`file` OPTIONAL, plus `patch`) —
 * by dropping any entry whose `file` is not a string. Never throws.
 */
function uniqueSummaryDiffs(raw: unknown): TimelineDiffStat[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TimelineDiffStat[] = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const file = record.file;
    if (typeof file !== 'string') continue;
    if (seen.has(file)) continue;
    seen.add(file);
    const stat: TimelineDiffStat = {
      file,
      additions: typeof record.additions === 'number' ? record.additions : 0,
      deletions: typeof record.deletions === 'number' ? record.deletions : 0,
    };
    const status = record.status;
    if (status === 'added' || status === 'deleted' || status === 'modified') stat.status = status;
    out.push(stat);
  }
  return out.reverse();
}

/** The id of the first assistant message the user interrupted, if any. */
function firstAbortedMessageId<M extends TimelineMessageLike>(turn: TurnLike<M>): string | undefined {
  for (const message of turn.assistantMessages) {
    if (isAbortError(message.info.error)) return message.info.id;
  }
  return undefined;
}

/** The turn's error text, or `undefined`. An abort is not an error. */
function turnErrorText<M extends TimelineMessageLike>(turn: TurnLike<M>): string | undefined {
  const last = turn.assistantMessages[turn.assistantMessages.length - 1];
  const error = last?.info.error;
  if (!error || isAbortError(error)) return undefined;
  return unwrapError(error);
}

// ============================================================================
// constructTimelineRows
// ============================================================================

/**
 * Flatten `messages` into ordered, uniquely-keyed rows.
 *
 * Per turn, in this exact order:
 *   `turn-gap` (never on the first turn) · [reserved: CommentStrip] ·
 *   `user-message` · `turn-divider{compaction}` · the assistant parts, with
 *   `turn-divider{interrupted}` at the aborted message's position ·
 *   `thinking` · `retry` · `diff-summary` · `error`.
 *
 * Deterministic: the same `messages` and `options` always produce structurally
 * identical rows in the same order. Never mutates its input.
 */
export function constructTimelineRows<M extends TimelineMessageLike>(
  messages: readonly M[],
  options?: ConstructTimelineRowsOptions<M>,
): TimelineRow[] {
  const turns = groupMessagesIntoTurns(messages);
  if (turns.length === 0) return [];

  const status = options?.status ?? 'idle';
  const showReasoning = options?.showReasoning ?? false;
  const isRenderablePart =
    options?.isRenderablePart ?? ((part: PartLike) => defaultIsRenderablePart(part, showReasoning));
  const groupPart = options?.groupPart;
  const getPartId = options?.getPartId;

  const activeUserMessageID =
    options?.activeUserMessageID ?? turns[turns.length - 1].userMessage.info.id;

  const rows: TimelineRow[] = [];
  // Uniqueness is otherwise implied (grouping dedupes user ids, each assistant
  // message lands in exactly one turn, each part is walked once) — but a
  // duplicate `part.id` inside one message's `parts` array would still collide,
  // and duplicate keys crash list renderers. NEVER throws: this is a render path.
  const usedKeys = new Set<string>();
  const uniqueKey = (candidate: string): string => {
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
    let n = 1;
    let next = `${candidate}:${n}`;
    while (usedKeys.has(next)) {
      n += 1;
      next = `${candidate}:${n}`;
    }
    usedKeys.add(next);
    return next;
  };

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    const userMessageID = turn.userMessage.info.id;
    const isActive = userMessageID === activeUserMessageID;

    if (turnIndex > 0) {
      rows.push({
        kind: 'turn-gap',
        key: uniqueKey(`turn-gap:${userMessageID}`),
        userMessageID,
      });
    }

    // [reserved] CommentStrip belongs here, between turn-gap and user-message.

    rows.push({
      kind: 'user-message',
      key: uniqueKey(`user-message:${userMessageID}`),
      userMessageID,
    });

    const compacted = turn.userMessage.parts.some(isCompactionPart);
    if (compacted) {
      rows.push({
        kind: 'turn-divider',
        key: uniqueKey(`turn-divider:${userMessageID}:compaction`),
        userMessageID,
        label: 'compaction',
      });
    }

    // A compaction turn suppresses the interrupted divider entirely.
    const abortedMessageId = compacted ? undefined : firstAbortedMessageId(turn);

    let partRowCount = 0;
    let openGroup: { id: string; refs: TimelinePartRef[] } | null = null;

    const pushGroupRow = (group: TimelinePartGroup): void => {
      rows.push({
        kind: 'assistant-part',
        key: uniqueKey(`assistant-part:${userMessageID}:${group.key}`),
        userMessageID,
        group,
        previousAssistantPart: partRowCount > 0,
      });
      partRowCount += 1;
    };

    const flushGroup = (): void => {
      if (!openGroup) return;
      const first = openGroup.refs[0];
      pushGroupRow({
        key: `context:${first.messageID}:${first.partID}`,
        type: 'context',
        refs: openGroup.refs,
      });
      openGroup = null;
    };

    for (const message of turn.assistantMessages) {
      if (abortedMessageId !== undefined && message.info.id === abortedMessageId) {
        // A group must not span the divider. The divider does NOT advance
        // `partRowCount` — it is not a part row.
        flushGroup();
        rows.push({
          kind: 'turn-divider',
          key: uniqueKey(`turn-divider:${userMessageID}:interrupted`),
          userMessageID,
          label: 'interrupted',
        });
      }

      for (let index = 0; index < message.parts.length; index++) {
        const part = message.parts[index];
        if (!isRenderablePart(part, message)) continue;

        const partID = getPartId
          ? getPartId(part, message, index)
          : defaultGetPartId(part, message.info.id, index);
        const ref: TimelinePartRef = { messageID: message.info.id, partID };

        const groupId = groupPart?.(part, message);
        if (groupId !== undefined) {
          if (openGroup && openGroup.id === groupId) {
            openGroup.refs.push(ref);
            continue;
          }
          flushGroup();
          openGroup = { id: groupId, refs: [ref] };
          continue;
        }

        flushGroup();
        pushGroupRow({ key: `part:${ref.messageID}:${ref.partID}`, type: 'part', ref });
      }
    }
    flushGroup();

    const errorText = turnErrorText(turn);

    if (
      isActive &&
      status === 'busy' &&
      errorText === undefined &&
      (showReasoning ? partRowCount === 0 : true)
    ) {
      rows.push({ kind: 'thinking', key: uniqueKey(`thinking:${userMessageID}`), userMessageID });
    }

    if (isActive && status === 'retry') {
      rows.push({ kind: 'retry', key: uniqueKey(`retry:${userMessageID}`), userMessageID });
    }

    const diffs = uniqueSummaryDiffs(turn.userMessage.info.summary?.diffs);
    if (diffs.length > 0 && (status === 'idle' || !isActive)) {
      rows.push({
        kind: 'diff-summary',
        key: uniqueKey(`diff-summary:${userMessageID}`),
        userMessageID,
        diffs,
      });
    }

    if (errorText !== undefined) {
      rows.push({
        kind: 'error',
        key: uniqueKey(`error:${userMessageID}`),
        userMessageID,
        text: errorText,
      });
    }
  }

  return rows;
}

// ============================================================================
// Equality — exhaustive, scalar-only, no deep walk
// ============================================================================

function samePartRef(a: TimelinePartRef, b: TimelinePartRef): boolean {
  return a.messageID === b.messageID && a.partID === b.partID;
}

function samePartGroup(a: TimelinePartGroup, b: TimelinePartGroup): boolean {
  if (a.key !== b.key || a.type !== b.type) return false;
  if (a.type === 'part') return samePartRef(a.ref, (b as { ref: TimelinePartRef }).ref);
  const other = (b as { refs: TimelinePartRef[] }).refs;
  if (a.refs.length !== other.length) return false;
  // Order-sensitive: a reordered run is a different render.
  for (let i = 0; i < a.refs.length; i++) {
    if (!samePartRef(a.refs[i], other[i])) return false;
  }
  return true;
}

function sameDiffStats(
  a: readonly TimelineDiffStat[],
  b: readonly TimelineDiffStat[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.file !== y.file ||
      x.additions !== y.additions ||
      x.deletions !== y.deletions ||
      x.status !== y.status
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Structural equality over the scalars a row itself declares.
 *
 * No `unknown` deep walk, no hash fast-path, no WeakMap cache, no generic
 * object compare — so nothing here can be fooled by a prototype or a mutated
 * field, and nothing here can mask a real change.
 *
 * The `default` arm's `never` assignment is an exhaustiveness guard: adding a
 * ninth row kind without adding its comparison is a COMPILE error, not a
 * silently stale row. It cannot force a comparison for a new FIELD on an
 * existing kind — which is the other half of why rows stay content-free.
 */
function timelineRowsEqual(a: TimelineRow, b: TimelineRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key || a.userMessageID !== b.userMessageID) return false;

  switch (a.kind) {
    // All of these rows' state is already implied by the key, so a key match
    // IS equality.
    case 'turn-gap':
    case 'user-message':
    case 'thinking':
    case 'retry':
      return true;
    case 'turn-divider':
      return a.label === (b as TimelineTurnDividerRow).label;
    case 'error':
      return a.text === (b as TimelineErrorRow).text;
    case 'diff-summary':
      return sameDiffStats(a.diffs, (b as TimelineDiffSummaryRow).diffs);
    case 'assistant-part': {
      const other = b as TimelineAssistantPartRow;
      return (
        a.previousAssistantPart === other.previousAssistantPart && samePartGroup(a.group, other.group)
      );
    }
    default: {
      const _never: never = a;
      return _never !== undefined && false;
    }
  }
}

// ============================================================================
// Context-key stabilization
// ============================================================================

function isContextRow(row: TimelineRow): row is TimelineAssistantPartRow & {
  group: { key: string; type: 'context'; refs: TimelinePartRef[] };
} {
  return row.kind === 'assistant-part' && row.group.type === 'context';
}

/**
 * Pin each new context group's key to the prior group it descends from.
 *
 * A context group's key is its FIRST member's, so a run that loses its head or
 * grows at the head silently RENAMES itself — destroying the row key, and with
 * it the measured height, the expand state and the mounted component. Ported
 * from OpenCode's `stabilizeContextKey`.
 *
 * Skipped entirely when no prior row is a context group, which is every caller
 * that does not pass `options.groupPart`.
 */
function stabilizeContextKeys(prev: readonly TimelineRow[], next: TimelineRow[]): TimelineRow[] {
  // Keyed by `userMessageID`, never by `messageID`, so one turn's context
  // identity can never be adopted by another turn's row.
  const contextByPart = new Map<string, { index: number; row: TimelineAssistantPartRow }>();
  let hasContextGroup = false;
  for (let index = 0; index < prev.length; index++) {
    const row = prev[index];
    if (!isContextRow(row)) continue;
    hasContextGroup = true;
    for (const ref of row.group.refs) {
      const lookup = `${row.userMessageID}:${ref.partID}`;
      if (!contextByPart.has(lookup)) contextByPart.set(lookup, { index, row });
    }
  }
  if (!hasContextGroup) return next;

  // A prior key a NEW row already carries naturally: its natural owner
  // outranks any would-be inheritor.
  const reserved = new Map<string, number>();
  for (let i = 0; i < next.length; i++) {
    const row = next[i];
    if (!isContextRow(row)) continue;
    if (!reserved.has(row.key)) reserved.set(row.key, i);
  }

  const claimed = new Set<string>();
  return next.map((row, i) => {
    if (!isContextRow(row)) return row;

    let best: { index: number; row: TimelineAssistantPartRow } | undefined;
    for (const ref of row.group.refs) {
      const candidate = contextByPart.get(`${row.userMessageID}:${ref.partID}`);
      if (!candidate) continue;
      if (claimed.has(candidate.row.key)) continue;
      const naturalOwner = reserved.get(candidate.row.key);
      if (naturalOwner !== undefined && naturalOwner !== i) continue;
      if (!best || candidate.index < best.index) best = candidate;
    }
    if (!best) return row;

    claimed.add(best.row.key);
    if (best.row.key === row.key) return row; // zero allocation
    return {
      ...row,
      key: best.row.key,
      group: { ...row.group, key: best.row.group.key },
    };
  });
}

// ============================================================================
// reuseTimelineRows
// ============================================================================

/**
 * Return `next`, with every row that did not change replaced by the PREVIOUS
 * object — and with `prev` itself returned when no row changed at all.
 *
 * That is the whole point: a frame that changes nothing preserves both the row
 * identities (so `memo` / `useMemo` `===` gates hold and the subtrees are
 * skipped) and the ARRAY identity (so the caller's `useMemo` on `rows` does not
 * fire at all).
 *
 * Idempotent — `reuseTimelineRows(reuseTimelineRows(p, n), n)` yields the same
 * objects — so it is safe to call during render, including under React
 * StrictMode's double render. Same precedent as
 * `apps/web/src/features/session/turn/stable-turns.ts`.
 */
export function reuseTimelineRows(
  prev: TimelineRow[] | undefined,
  next: TimelineRow[],
): TimelineRow[] {
  // PHASE 0 — cold path. No allocation on first mount.
  if (!prev || prev.length === 0) return next;

  // PHASE 1 — index the previous rows. `byKey.get` can only return a row whose
  // key matches, and `kind` is encoded in every key, so a reused row can never
  // change `kind` under a stable key.
  const byKey = new Map<string, TimelineRow>();
  for (const row of prev) {
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  }

  // PHASE 2 — context-group key stabilization.
  const stabilized = stabilizeContextKeys(prev, next);

  // PHASE 3 — per-row identity swap. Three outcomes, no fourth.
  const out = stabilized.map((row) => {
    const existing = byKey.get(row.key);
    if (!existing) return row;
    return timelineRowsEqual(existing, row) ? existing : row;
  });

  // PHASE 4 — array collapse. Reference compare against `out`, NOT `next`:
  // phase 3 already normalized to the prior objects wherever possible, and
  // comparing `next` here would still return correct DATA while never
  // returning `prev` — silently delivering none of the benefit.
  if (prev.length === out.length && prev.every((row, i) => row === out[i])) return prev;
  return out;
}
