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
 * Display order: `time.created` first, wire id as the tiebreak.
 *
 * The sync store keeps messages sorted by ID (its binary-search invariant),
 * and the id is CLIENT-minted for user messages — a wrong one used to teleport
 * a bubble to the top of the thread. OpenCode stamps `time.created` at
 * persistence, from the box's clock, so a message ordered by it lands where it
 * happened whatever id it travelled under; a foreign or backdated id degrades
 * to slightly-odd placement at worst. A message with no timestamp (an
 * optimistic stub) sorts as newest — it is the latest thing the user did — and
 * two untimed messages keep their INPUT order, so a host that feeds unstamped
 * messages sees exactly the sequential behaviour it always had. Equal stamps
 * keep id order. A weak order (stable sort), never a partial one.
 */
export function compareMessagesForDisplay(
  a: { info: { id: string; time?: { created?: number } } },
  b: { info: { id: string; time?: { created?: number } } },
): number {
  const at = typeof a.info.time?.created === 'number' ? a.info.time.created : null;
  const bt = typeof b.info.time?.created === 'number' ? b.info.time.created : null;
  if (at === null && bt === null) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0;
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
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      lastTurn = turnsByUserMsgId.get(msg.info.id) ?? null;
      continue;
    }

    if (msg.info.role !== 'assistant') continue;

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
    if (turns.length > 0) {
      turns[0].assistantMessages.unshift(msg);
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
