/**
 * Turn grouping & part-collection helpers — framework-agnostic.
 *
 * Groups raw messages into turns, and collects/aggregates parts across a
 * turn or a whole session's sessions list.
 *
 * Split out of `turns/index.ts` — see that file's history for the original
 * single-file version. No React / DOM / framework imports allowed.
 */

import type { MessageWithPartsLike, PartLike, PartWithMessage, ToolPartLike, TurnLike } from './types';
import { isTextPart, isToolPart } from './parts';

// ============================================================================
// Internal wire shapes (structural casts, never exported)
// ============================================================================

interface TextPartLike extends PartLike {
  type: 'text';
  text?: string;
  synthetic?: boolean;
}

// ============================================================================
// Turn grouping
// ============================================================================

/**
 * Display order, as a TOTAL order over two disjoint segments.
 *
 *   1. PLACED — the message has a wire id, so the server has given it a
 *      position. Ordered by that id.
 *   2. LOCAL — an optimistic stub, or a queued inbox row the transcript has
 *      not echoed yet. Ordered by the instant the user sent it, untimed last.
 *
 * Every placed message precedes every local one, because a local placeholder
 * exists precisely because the server has not placed it yet; the moment it is
 * echoed it gains a wire id and moves into segment 1.
 *
 * The wire id is the message's POSITION: OpenCode's own loop resolves "is this
 * answered?" by id order, and every id that reaches the transcript is placed by
 * the control plane (the proxy's wire-id repair lifts a stale client id; the
 * drain re-mints a queued prompt above the live turn). So for wire ids, id
 * order IS conversation order.
 *
 * `time.created` is NOT, which is why it only ever orders segment 2. OpenCode
 * stamps it at PERSISTENCE, from arrival wall-clock. A batch of queued prompts
 * is posted concurrently on purpose (so one step answers them all), and their
 * arrival order is the network's — sorting placed messages by it displayed
 * "B4, FIRST, B2, B3" for a burst the model itself read, and answered, in id
 * order.
 *
 * WHY THE SEGMENTS. This function used to switch ordering per PAIR: wire-id
 * order when both ids were well-formed wire ids, `time.created` for every pair
 * involving anything else. That is not an order at all. Two placed messages A,
 * B and one queued row S whose host-fabricated stamp sat below the box clock
 * compared as A < B (by id), S < A (by time) and B < S (by time) — a cycle.
 * `Array.prototype.sort` may emit any permutation of a cyclic comparator, and
 * V8 switches algorithm with input length, so three prompts sent "who", "are",
 * "you" rendered "who", "you", "are". `groupMessagesIntoTurns` walks the same
 * sorted list to attach assistant messages that carry no `parentID`, so the
 * replies re-parented too, and a queued row could sort ABOVE the whole
 * transcript. Segmenting removes the mixed comparison, and with it the need
 * for any host to fabricate a timestamp to keep a queued row in place.
 *
 * A message with no timestamp AND no wire id (a host's plain stub) sorts last —
 * it is the latest thing the user did — and two such are a TIE, so the stable
 * sort keeps the order the host handed them over in. Equal timestamps keep id
 * order.
 */
const WIRE_DISPLAY_ID = /^msg_[0-9a-f]{12}/;

/** `0` for a message the server has placed, `1` for one only this tab knows. */
function displaySegment(id: string): 0 | 1 {
  return WIRE_DISPLAY_ID.test(id) ? 0 : 1;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareMessagesForDisplay(
  a: { info: { id: string; time?: { created?: number } } },
  b: { info: { id: string; time?: { created?: number } } },
): number {
  const segmentA = displaySegment(a.info.id);
  const segmentB = displaySegment(b.info.id);
  if (segmentA !== segmentB) return segmentA - segmentB;

  // Placed: the wire id is the position, and it is the only clock that agrees
  // with the loop that produced the messages.
  if (segmentA === 0) return compareIds(a.info.id, b.info.id);

  // Local: the send instant is the only record of what the user did, and it is
  // this tab's own clock for both sides, so it is comparable. Untimed last.
  const at = typeof a.info.time?.created === 'number' ? a.info.time.created : null;
  const bt = typeof b.info.time?.created === 'number' ? b.info.time.created : null;
  // Two untimed stubs are a TIE, so the stable sort keeps the order the host
  // handed them over in. That is the only signal left about which came first,
  // and an id tiebreak here would reorder `groupMessagesIntoTurns`' own
  // sequential fallback (`u1`, `a1`, `a2` regrouped as `a1`, `a2`, `u1`).
  if (at === null && bt === null) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  if (at !== bt) return at < bt ? -1 : 1;
  return compareIds(a.info.id, b.info.id);
}

/**
 * Group messages into turns: each turn starts with a user message followed
 * by 0+ assistant messages.
 *
 * Uses parentID-based linking (matching SolidJS session-turn.tsx:272-292):
 * assistant messages are associated with their parent user message via
 * `parentID`. Falls back to sequential ordering when parentID is absent —
 * sequential in DISPLAY order (`compareMessagesForDisplay`), not input order.
 */
export function groupMessagesIntoTurns<M extends MessageWithPartsLike>(
  input: readonly M[],
): TurnLike<M>[] {
  const messages = [...input].sort(compareMessagesForDisplay);
  const turns: TurnLike<M>[] = [];
  const turnsByUserMsgId = new Map<string, TurnLike<M>>();

  // First pass: create turns from user messages.
  // Dedupe by id — a user message can transiently appear twice (e.g. an
  // optimistic copy + the real one before reconcile finishes, or a hydrate
  // that races a part.updated event). Two turns with the same userMessage.id
  // would crash list renderers keyed by it (e.g. FlatList's keyExtractor).
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      if (turnsByUserMsgId.has(msg.info.id)) continue;
      const turn: TurnLike<M> = { userMessage: msg, assistantMessages: [] };
      turns.push(turn);
      turnsByUserMsgId.set(msg.info.id, turn);
    }
  }

  // Second pass: link assistant messages via parentID or sequential
  let lastTurn: TurnLike<M> | null = null;
  // Assistant ids are deduped the same way user ids are: a message that
  // transiently appears twice (an optimistic stub beside its reconciled copy,
  // a hydrate racing a `part.updated`) must land in its turn ONCE, or every
  // list keyed by message id renders it twice.
  const seenAssistantIds = new Set<string>();
  // How many orphans `turns[0]` has received so far — see the orphan branch.
  let orphanCount = 0;
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      lastTurn = turnsByUserMsgId.get(msg.info.id) ?? null;
      continue;
    }

    if (msg.info.role !== 'assistant') continue;

    if (seenAssistantIds.has(msg.info.id)) continue;
    seenAssistantIds.add(msg.info.id);

    const assistantMsg = msg.info;

    // Try parentID-based linking first (matches SolidJS)
    if (assistantMsg.parentID) {
      const parentTurn = turnsByUserMsgId.get(assistantMsg.parentID);
      if (parentTurn) {
        parentTurn.assistantMessages.push(msg);
        continue;
      }
    }

    // Fall back to sequential ordering — attach to the most recently seen
    // user turn in iteration order. This keeps streaming parts that arrive
    // before their parent metadata in the right turn.
    if (lastTurn) {
      lastTurn.assistantMessages.push(msg);
      continue;
    }

    // Orphan assistant message that precedes every user message in the
    // session (e.g. a session-init failure with no parentID). Attaching to
    // the LAST turn would surface its error under an unrelated, much later
    // user prompt. Attach to the FIRST turn instead so it renders at its
    // real chronological position — or create a synthetic turn if no user
    // messages exist at all.
    //
    // Orphans LEAD the first turn, in DISPLAY order. The walk is already in
    // display order, so the k-th orphan goes to slot k — ahead of any reply
    // a `parentID` hit may have pushed earlier (a placed reply whose parent
    // is a still-local stub sorts before that stub), and after every orphan
    // before it. This used to `unshift` each one, which reversed them:
    // three init failures 1, 2, 3 rendered 3, 2, 1.
    if (turns.length > 0) {
      turns[0].assistantMessages.splice(orphanCount, 0, msg);
      orphanCount += 1;
      continue;
    }

    const syntheticTurn: TurnLike<M> = { userMessage: msg, assistantMessages: [] };
    turns.push(syntheticTurn);
  }

  return turns;
}

// ============================================================================
// Part collection helpers
// ============================================================================

/** Collect all parts from a turn's assistant messages. */
export function collectTurnParts<M extends MessageWithPartsLike>(
  turn: TurnLike<M>,
): PartWithMessage<M>[] {
  const result: PartWithMessage<M>[] = [];
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      result.push({ part, message: msg } as PartWithMessage<M>);
    }
  }
  return result;
}

/** Find the last non-empty text part in a turn (the "response"). */
export function findLastTextPart<P extends PartLike>(
  parts: ReadonlyArray<{ part: P }>,
): (P & { type: 'text' }) | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].part;
    if (isTextPart(p) && (p as PartLike as TextPartLike).text?.trim()) {
      return p;
    }
  }
  return undefined;
}

/** Check if a turn has tool steps. */
export function turnHasSteps(parts: ReadonlyArray<{ part: PartLike }>): boolean {
  return parts.some(
    ({ part }) =>
      part.type === 'tool' ||
      part.type === 'compaction' ||
      part.type === 'snapshot' ||
      part.type === 'patch',
  );
}

// ============================================================================
// Answered question parts (shown when collapsed)
// ============================================================================

/**
 * Collect answered question parts that should be shown outside of the
 * steps list. Questions are always rendered standalone (never inside steps),
 * so answered questions are shown regardless of stepsExpanded state.
 */
export function getAnsweredQuestionParts<M extends MessageWithPartsLike>(
  turn: TurnLike<M>,
  _stepsExpanded: boolean,
  hasActiveQuestion: boolean,
): PartWithMessage<M>[] {
  // Active question takes precedence — don't also show old answered ones
  if (hasActiveQuestion) return [];

  const result: PartWithMessage<M>[] = [];
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      if (!isToolPart(part)) continue;
      const tp = part as PartLike as ToolPartLike;
      const answers = (tp.state?.metadata as { answers?: unknown[] } | undefined)?.answers;
      if (tp.tool === 'question' && (answers?.length ?? 0) > 0) {
        result.push({ part, message: msg } as PartWithMessage<M>);
      }
    }
  }
  return result;
}

// ============================================================================
// Session list helpers (sidebar / tabs)
// ============================================================================

/**
 * Build a map from parent session ID → array of child session IDs.
 * Used to aggregate child session status (permissions, busy) in the sidebar.
 * Matches SolidJS reference `childMapByParent()` in helpers.ts.
 */
export function childMapByParent(
  sessions: ReadonlyArray<{ id: string; parentID?: string }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const existing = map.get(session.parentID);
    if (existing) {
      existing.push(session.id);
    } else {
      map.set(session.parentID, [session.id]);
    }
  }
  return map;
}

/**
 * Sort comparator for sessions.
 * Two tiers:
 *  1. Sessions updated within `now - 60s` are pinned to top, sorted by ID (stable).
 *  2. Older sessions sorted by `updated` time descending.
 * Matches SolidJS reference `sortSessions()` in helpers.ts.
 */
export function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000;
  return (
    a: { id: string; time: { updated?: number; created: number } },
    b: { id: string; time: { updated?: number; created: number } },
  ) => {
    const aUpdated = a.time.updated ?? a.time.created;
    const bUpdated = b.time.updated ?? b.time.created;
    const aRecent = aUpdated > oneMinuteAgo;
    const bRecent = bUpdated > oneMinuteAgo;
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;
    return bUpdated - aUpdated;
  };
}

/**
 * Recursively collect ALL descendant session IDs for a given parent.
 * Walks the full tree so deeply nested sub-agents are included.
 */
export function allDescendantIds(childMap: Map<string, string[]>, sessionId: string): string[] {
  const directChildren = childMap.get(sessionId);
  if (!directChildren || directChildren.length === 0) return [];
  const result: string[] = [];
  for (const childId of directChildren) {
    result.push(childId);
    result.push(...allDescendantIds(childMap, childId));
  }
  return result;
}
