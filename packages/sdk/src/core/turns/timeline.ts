/**
 * Timeline rows — the flat, ordered, virtualizer-ready projection of a
 * transcript, plus an identity-preserving reuse pass.
 *
 * PURE AND FRAMEWORK-FREE. This module imports only `./types`, `./parts`,
 * `./grouping`, `./errors` and `../http/abort-error`, all `isomorphic-core`
 * (`abort-error.ts` imports nothing at all). It reads no global —
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
import { compareMessagesForDisplay, groupMessagesIntoTurns } from './grouping';
import { unwrapError } from './errors';
import { abortErrorReason, isAbortError } from '../http/abort-error';
import type { MessageInfoLike, MessageWithPartsLike, PartLike, ToolPartLike, TurnLike } from './types';

// ============================================================================
// The abort literal
// ============================================================================

/**
 * The `info.error.name` OpenCode stamps on a message the RUNTIME interrupted.
 *
 * It is a wire string, not a typed constant in this repo, so it lives here once
 * and is asserted in `timeline.test.ts`. Re-check on each `@opencode-ai/sdk`
 * bump.
 *
 * INFORMATIONAL ONLY — this module does not classify with it. Aborts are
 * classified by `isAbortError` (`core/http/abort-error.ts`), the SDK's single
 * abort detector, whose own header records the four divergent detectors that
 * preceded it. A local `name === MESSAGE_ABORTED_ERROR_NAME` check lived here
 * and was a FIFTH: it missed `name: 'AbortError'` — the shape
 * `applyOptimisticAbort` patches on when the USER hits Stop — so every
 * user-initiated stop rendered as an `error` row reading "The operation was
 * aborted." instead of the interrupted divider. It also shadowed the canonical
 * export by name, so the two could never be compared side by side.
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

/**
 * The user's prompt. One per turn — except an assistant-only turn (see
 * `constructTimelineRows`), which has no prompt and emits none.
 */
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

/**
 * The pre-first-token placeholder on the active, busy turn. Emitted ONLY while
 * that turn has no `assistant-part` row yet, in either reasoning mode — it is a
 * placeholder for content that has not arrived, never a footer under content
 * that has.
 */
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

/**
 * A failure. An abort is NOT an error — it is the interrupted divider.
 *
 * A turn emits up to TWO: one for its ORPHAN preamble (assistant messages that
 * precede the prompt — a session-init failure grouped under the first turn,
 * see `groupMessagesIntoTurns`), keyed `error:<userMessageID>:orphan` and
 * placed right after the preamble's parts; and one for the turn's REPLY,
 * keyed `error:<userMessageID>` and placed last. A clean reply clears an
 * earlier failed reply (a retry); it never clears a preamble failure, which
 * happened before the prompt was sent and was not retried by it.
 */
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
  /**
   * Render `reasoning` parts. Does NOT gate the `thinking` row: that is the
   * pre-first-token placeholder and is suppressed by the first part row of the
   * turn in either mode.
   */
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
   * The fallback is best-effort, never the intended path. `msg:#0` names a
   * SLOT, not a part: insert a part ahead of it and every following row is
   * renamed (the scroll-jump and remount the key model exists to prevent),
   * while the HEAD row keeps `:#0` even though that slot now holds a different
   * part — key and ref stay byte-identical while the content behind them
   * changed. That is why `reuseTimelineRows` never hands back a previous row
   * object for a positional-fallback row (see `isPositionalPartRef`): such a
   * row costs one allocation per frame, which is the price of having no wire
   * id. Override this when your parts have no wire id.
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

/**
 * Is this abort one the transcript shows as "Interrupted"?
 *
 * `isAbortError` answers "was this an abort"; `abortErrorReason` answers WHY.
 * Only a user Stop (`reason: 'user'`, patched by `applyOptimisticAbort`) or a
 * reason-less real wire `MessageAbortedError` is a cut turn. A
 * `reason: 'runtime-disposed'` abort is the one `markSessionAbortedLocally`
 * stamps on EVERY non-idle session when OpenCode respawns — pure
 * infrastructure, and per `ABORT_REASONS` it "must render nothing: a respawn
 * that recovers cleanly should not scar the transcript". So it is neither a
 * divider nor an error row. This is the same gate
 * `apps/web/.../session-error-banner.tsx` applies (`abortReason !== 'user'`
 * → null); the row model honours it so no host has to.
 */
function isInterruptingAbort(error: unknown): boolean {
  if (!isAbortError(error)) return false;
  const reason = abortErrorReason(error);
  return reason === undefined || reason === 'user';
}

/**
 * The id of the first assistant message the user interrupted, if any.
 *
 * Takes the turn's assistant RUN, not the turn: an assistant-only turn's run
 * starts at `turn.userMessage` (see `assistantRunOf`), and reading
 * `turn.assistantMessages` there would scan an empty array and miss the abort.
 */
function firstInterruptedMessageId<M extends TimelineMessageLike>(
  run: readonly M[],
): string | undefined {
  for (const message of run) {
    if (isInterruptingAbort(message.info.error)) return message.info.id;
  }
  return undefined;
}

/**
 * The error text of the run segment `[start, end)`, or `undefined`. Reads the
 * segment's LAST member only: a later clean message in the same segment is a
 * retry that cleared the earlier failure. An abort is not an error.
 */
function segmentErrorText<M extends TimelineMessageLike>(
  run: readonly M[],
  start: number,
  end: number,
): string | undefined {
  if (end <= start) return undefined;
  const error = run[end - 1].info.error;
  if (!error || isAbortError(error)) return undefined;
  return unwrapError(error);
}

/**
 * How many leading run members are ORPHANS — assistant messages that precede
 * the turn's prompt in display order and are not its replies.
 *
 * `groupMessagesIntoTurns` attaches an assistant message that precedes every
 * user message (a session-init failure with no resolvable `parentID`) to the
 * FIRST turn, at the head of `assistantMessages`, in display order. Those
 * messages are not replies to the prompt: the prompt came AFTER them, and a
 * clean reply does not retry them. So the run is two segments — the orphan
 * preamble and the replies — and each carries its own error. Without this
 * split, `run.at(-1)`'s error was the whole turn's, and one clean reply
 * deleted the init failure from the transcript (F2).
 *
 * Zero for an assistant-only turn: its head IS the first assistant message.
 */
function preambleLength<M extends TimelineMessageLike>(
  turn: TurnLike<M>,
  run: readonly M[],
): number {
  if (isAssistantOnlyTurn(turn)) return 0;
  const prompt = turn.userMessage;
  let count = 0;
  for (const message of run) {
    if (message.info.parentID === prompt.info.id) break;
    if (compareMessagesForDisplay(message, prompt) >= 0) break;
    count += 1;
  }
  return count;
}

/**
 * Is this turn's `userMessage` actually an ASSISTANT message?
 *
 * `groupMessagesIntoTurns` synthesizes such a turn when the session's first
 * message is an orphan assistant message — a session-init failure that carries
 * no `parentID` and precedes every user prompt — and there is no user message
 * to attach it to. Its head is the assistant run, not a prompt.
 */
function isAssistantOnlyTurn<M extends TimelineMessageLike>(turn: TurnLike<M>): boolean {
  return turn.userMessage.info.role === 'assistant';
}

/**
 * The assistant messages of a turn, in render order.
 *
 * For an assistant-only turn the head message IS the first assistant message,
 * so it leads the run. Allocates a new array ONLY in that degenerate case; the
 * normal path returns `turn.assistantMessages` itself.
 */
function assistantRunOf<M extends TimelineMessageLike>(turn: TurnLike<M>): readonly M[] {
  return isAssistantOnlyTurn(turn)
    ? [turn.userMessage, ...turn.assistantMessages]
    : turn.assistantMessages;
}

// ============================================================================
// constructTimelineRows
// ============================================================================

/**
 * Flatten `messages` into ordered, uniquely-keyed rows.
 *
 * Per turn, in this exact order:
 *   `turn-gap` (never on the first turn) · [reserved: CommentStrip] ·
 *   `user-message` · `turn-divider{compaction}` · the ORPHAN preamble's parts ·
 *   the preamble's `error` (see `preambleLength`) · the reply parts, with
 *   `turn-divider{interrupted}` at the interrupted message's position ·
 *   `thinking` · `retry` · `diff-summary` · the reply's `error`.
 *
 * An ASSISTANT-ONLY turn — the synthetic turn `groupMessagesIntoTurns` builds
 * for an orphan assistant message that precedes every prompt — emits no
 * `user-message` row and no compaction divider. Its head message leads the
 * assistant run, so its parts, its abort divider and its error all render.
 *
 * An abort renders as the interrupted divider ONLY when it is a user Stop or a
 * reason-less wire abort (`isInterruptingAbort`); a `'runtime-disposed'` abort
 * renders nothing — no divider, no error row. An interrupted turn never emits
 * `thinking`: it is not thinking, it was stopped.
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
  // The next suffix to TRY for a candidate that already collided. Without it
  // the search restarted at `:1` on every collision, so k duplicates of one id
  // cost O(k^2) set probes — 745ms at k=4000, on a function that runs once per
  // frame while a turn streams. Remembering where each candidate got to makes
  // the whole run amortized O(k). The `while` still guards the case where a
  // suffix key is ALSO some other part's natural key.
  const nextSuffix = new Map<string, number>();
  const uniqueKey = (candidate: string): string => {
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
    let n = nextSuffix.get(candidate) ?? 1;
    let next = `${candidate}:${n}`;
    while (usedKeys.has(next)) {
      n += 1;
      next = `${candidate}:${n}`;
    }
    nextSuffix.set(candidate, n + 1);
    usedKeys.add(next);
    return next;
  };

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    const userMessageID = turn.userMessage.info.id;
    const isActive = userMessageID === activeUserMessageID;
    // An assistant-only turn has no prompt: its head message is the first
    // ASSISTANT message. Emitting a `user-message` row for it both mislabels
    // the row and drops the message's parts and error, because neither the
    // part loop nor `turnErrorText` ever looked at `turn.userMessage`.
    const assistantOnly = isAssistantOnlyTurn(turn);
    const assistantRun = assistantRunOf(turn);

    if (turnIndex > 0) {
      rows.push({
        kind: 'turn-gap',
        key: uniqueKey(`turn-gap:${userMessageID}`),
        userMessageID,
      });
    }

    // [reserved] CommentStrip belongs here, between turn-gap and user-message.

    if (!assistantOnly) {
      rows.push({
        kind: 'user-message',
        key: uniqueKey(`user-message:${userMessageID}`),
        userMessageID,
      });
    }

    const compacted = !assistantOnly && turn.userMessage.parts.some(isCompactionPart);
    if (compacted) {
      rows.push({
        kind: 'turn-divider',
        key: uniqueKey(`turn-divider:${userMessageID}:compaction`),
        userMessageID,
        label: 'compaction',
      });
    }

    // An interrupted turn is not thinking, compacted or not. A compaction
    // turn additionally suppresses the interrupted DIVIDER.
    const interruptedMessageId = firstInterruptedMessageId(assistantRun);
    const abortedMessageId = compacted ? undefined : interruptedMessageId;
    const preamble = preambleLength(turn, assistantRun);
    const preambleErrorText = segmentErrorText(assistantRun, 0, preamble);
    const errorText = segmentErrorText(assistantRun, preamble, assistantRun.length);

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

    // The preamble's failure renders where it happened — after the preamble's
    // parts, before the first reply. A group must not span it.
    const pushPreambleError = (): void => {
      if (preambleErrorText === undefined) return;
      flushGroup();
      rows.push({
        kind: 'error',
        key: uniqueKey(`error:${userMessageID}:orphan`),
        userMessageID,
        text: preambleErrorText,
      });
    };

    for (let messageIndex = 0; messageIndex < assistantRun.length; messageIndex++) {
      const message = assistantRun[messageIndex];
      if (messageIndex === preamble) pushPreambleError();
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
    // A run that is ONLY the preamble (the prompt has no reply yet): the loop
    // never reached index `preamble`, so the preamble error is emitted here.
    if (preamble === assistantRun.length) pushPreambleError();

    // `partRowCount === 0` unconditionally — `thinking` is the PRE-first-token
    // placeholder. The condition used to be `showReasoning ? partRowCount === 0
    // : true`, so with the DEFAULT `showReasoning: false` the placeholder
    // rendered BELOW parts that had already streamed. A hidden reasoning part
    // produces no part row, so the reasoning-heavy case this was reaching for
    // is already covered by the count itself.
    //
    // `interruptedMessageId === undefined` — an interrupted turn is not
    // thinking. Without it a busy, active, stopped turn with zero parts showed
    // "Interrupted" above a live spinner. A `'runtime-disposed'` abort does NOT
    // suppress it: it renders as if it never happened, and the respawned
    // runtime may well be working on this very turn.
    if (
      isActive &&
      status === 'busy' &&
      errorText === undefined &&
      partRowCount === 0 &&
      interruptedMessageId === undefined
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

/**
 * Did this ref's `partID` come from `defaultGetPartId`'s POSITIONAL fallback?
 *
 * A positional id encodes a slot (`<messageID>:#<index>`), not a part, so two
 * refs can be byte-identical and still name different parts across a prepend —
 * exactly the case where reusing the previous row object pins a memoized
 * subtree to content that has moved. No wire part id can collide with this
 * shape: every real id is a `prt_…`-style token with no `:#` in it. A custom
 * `options.getPartId` that mints this shape is treated the same way, which is
 * the conservative direction.
 */
function isPositionalPartRef(ref: TimelinePartRef): boolean {
  // Length + charCode, not `startsWith(`${messageID}:#`)`: that template
  // allocated a string per ref per equality check, on a path that runs for
  // every part row on every frame.
  const { messageID, partID } = ref;
  const prefix = messageID.length;
  return (
    partID.length >= prefix + 2 &&
    partID.charCodeAt(prefix) === 58 /* ':' */ &&
    partID.charCodeAt(prefix + 1) === 35 /* '#' */ &&
    partID.startsWith(messageID)
  );
}

/** Does any ref in this group carry a positional-fallback id? */
function hasPositionalPartRef(group: TimelinePartGroup): boolean {
  return group.type === 'part'
    ? isPositionalPartRef(group.ref)
    : group.refs.some(isPositionalPartRef);
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
 *
 * ONE deliberate asymmetry: an `assistant-part` row built on POSITIONAL part
 * ids is never equal to another row, even to a byte-identical one. A
 * positional id names a slot, so identical scalars do not prove identical
 * content. See `isPositionalPartRef`.
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
      if (a.previousAssistantPart !== other.previousAssistantPart) return false;
      if (!samePartGroup(a.group, other.group)) return false;
      // Equal-LOOKING is not equal when the ids are positional: `msg:#0` after
      // a prepend refs a different part under the same key. Reuse would hand
      // back the previous object — the stale direction — so refuse. Rows with
      // real wire ids are unaffected, which is every non-fixture caller.
      return !hasPositionalPartRef(a.group);
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
 * What it allocates, exactly:
 *   - NOTHING when `prev` holds no context group, which is every caller that
 *     does not pass `options.groupPart`: the `prev` scan runs (whether a prior
 *     row is a context group is not knowable without looking) and returns
 *     `next` ITSELF. The context index is created lazily on the FIRST context
 *     row found, so the scan itself allocates no map.
 *   - When `prev` holds a context group: the context index (`contextByPart`,
 *     one `Map`), the natural-owner index (`reserved`, one `Map`), and the
 *     `claimed` set. Still no per-row allocation and no output array unless a
 *     key is actually rewritten; a steady-state frame returns `next` itself.
 */
function stabilizeContextKeys(prev: readonly TimelineRow[], next: TimelineRow[]): TimelineRow[] {
  // Keyed by `userMessageID`, never by `messageID`, so one turn's context
  // identity can never be adopted by another turn's row. Allocated on the
  // first context row, not up front: the no-context frame must cost nothing.
  let contextByPart: Map<string, { index: number; row: TimelineAssistantPartRow }> | undefined;
  for (let index = 0; index < prev.length; index++) {
    const row = prev[index];
    if (!isContextRow(row)) continue;
    contextByPart ??= new Map();
    for (const ref of row.group.refs) {
      const lookup = `${row.userMessageID}:${ref.partID}`;
      if (!contextByPart.has(lookup)) contextByPart.set(lookup, { index, row });
    }
  }
  if (contextByPart === undefined) return next;

  // A prior key a NEW row already carries naturally: its natural owner
  // outranks any would-be inheritor.
  const reserved = new Map<string, number>();
  for (let i = 0; i < next.length; i++) {
    const row = next[i];
    if (!isContextRow(row)) continue;
    if (!reserved.has(row.key)) reserved.set(row.key, i);
  }

  const claimed = new Set<string>();
  // Written lazily: `out` is allocated on the FIRST row whose key is actually
  // rewritten, so a frame that renames nothing returns `next` itself.
  let out: TimelineRow[] | undefined;
  for (let i = 0; i < next.length; i++) {
    const row = next[i];
    let replacement: TimelineRow = row;

    if (isContextRow(row)) {
      let best: { index: number; row: TimelineAssistantPartRow } | undefined;
      for (const ref of row.group.refs) {
        const candidate = contextByPart.get(`${row.userMessageID}:${ref.partID}`);
        if (!candidate) continue;
        if (claimed.has(candidate.row.key)) continue;
        const naturalOwner = reserved.get(candidate.row.key);
        if (naturalOwner !== undefined && naturalOwner !== i) continue;
        if (!best || candidate.index < best.index) best = candidate;
      }
      if (best) {
        claimed.add(best.row.key);
        if (best.row.key !== row.key) {
          replacement = {
            ...row,
            key: best.row.key,
            group: { ...row.group, key: best.row.group.key },
          };
        }
      }
    }

    if (out === undefined) {
      if (replacement === row) continue;
      out = next.slice(0, i);
    }
    out.push(replacement);
  }
  return out ?? next;
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
 * Allocates at most ONE array — the output — and only when a row is actually
 * swapped or a context key actually rewritten. A frame that changes nothing
 * allocates exactly the `prev` key index (`byKey`, one `Map`) — plus, only
 * when `prev` holds a context group, the two indexes and one set
 * `stabilizeContextKeys` documents. `timeline.test.ts` counts the `Map`
 * constructions and pins both numbers.
 *
 * Idempotent — `reuseTimelineRows(reuseTimelineRows(p, n), n)` yields the same
 * objects — so it is safe to call during render, including under React
 * StrictMode's double render. Same precedent as
 * `apps/web/src/features/session/turn/stable-turns.ts`.
 *
 * One row kind opts OUT of reuse: an `assistant-part` row whose part ids came
 * from the positional fallback (`isPositionalPartRef`). Its key cannot prove
 * its content, so it is re-taken every frame.
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

  // PHASE 3 — per-row identity swap. Three outcomes, no fourth. Allocated
  // lazily, same as phase 2: a frame on which no row resolves to a different
  // object than `stabilized` already holds allocates no array at all.
  let out: TimelineRow[] | undefined;
  for (let i = 0; i < stabilized.length; i++) {
    const row = stabilized[i];
    const existing = byKey.get(row.key);
    const resolved = existing !== undefined && timelineRowsEqual(existing, row) ? existing : row;
    if (out === undefined) {
      if (resolved === row) continue;
      out = stabilized.slice(0, i);
    }
    out.push(resolved);
  }
  const resolved = out ?? stabilized;

  // PHASE 4 — array collapse. Reference compare against the RESOLVED rows, NOT
  // `next`: phase 3 already normalized to the prior objects wherever possible,
  // and comparing `next` here would still return correct DATA while never
  // returning `prev` — silently delivering none of the benefit.
  if (prev.length === resolved.length && prev.every((row, i) => row === resolved[i])) return prev;
  return resolved;
}
