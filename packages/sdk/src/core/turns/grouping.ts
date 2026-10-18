/**
 * Turn grouping & part-collection helpers — framework-agnostic.
 *
 * Groups raw messages into turns, and collects/aggregates parts across a
 * turn or a whole session's sessions list.
 *
 * Split out of `turns/index.ts` — see that file's history for the original
 * single-file version. No React / DOM / framework imports allowed.
 */

import type { MessageInfoLike, MessageWithPartsLike, PartLike, PartWithMessage, ToolPartLike, TurnLike } from './types';
import { isTextPart, isToolPart } from './parts';
import { compareForDisplayAt, untimedAnchorOf } from './display-order';

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
  options?: { pendingMessageIds?: ReadonlySet<string> },
): TurnLike<M>[] {
  // Client-minted wire IDs are not proof of delivery. Keep inbox placeholders
  // after the transcript, in the durable queue's order, until they are released.
  const pendingOrder = new Map(
    [...(options?.pendingMessageIds ?? [])].map((id, index) => [id, index]),
  );
  const untimedAnchor = untimedAnchorOf(input);
  const messages = [...input].sort((a, b) => {
    const aPending = pendingOrder.get(a.info.id);
    const bPending = pendingOrder.get(b.info.id);
    if (aPending !== undefined && bPending !== undefined) return aPending - bPending;
    if (aPending !== undefined) return 1;
    if (bPending !== undefined) return -1;
    return compareForDisplayAt(a, b, untimedAnchor);
  });
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
  // Assistant messages that precede every loaded prompt, in display order.
  // Those that name a parent are the tail of a turn whose prompt the loaded
  // window did not reach (a long run); each run of them becomes a `partial`
  // turn. Those that name none (a session-init failure) keep their contract:
  // the first turn, or a synthetic turn when no prompt is loaded at all.
  const partialTurns: TurnLike<M>[] = [];
  const leadingParentless: M[] = [];
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      lastTurn = turnsByUserMsgId.get(msg.info.id) ?? null;
      continue;
    }

    if (msg.info.role !== 'assistant') continue;

    const assistantMsg = msg.info;

    // A runtime can persist an assistant shell before it writes any content.
    // If that shell completes with zero usage and zero parts, it is an audit
    // record, not a visible response. Keeping it in the source transcript
    // preserves auditability; omitting it from the render projection prevents
    // a malformed or stale parent from making a later user prompt look active.
    const tokens = assistantMsg.tokens;
    if (
      !assistantMsg.error &&
      msg.parts.length === 0 &&
      tokens?.input === 0 &&
      tokens.output === 0 &&
      tokens.reasoning === 0
    ) {
      continue;
    }

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

    // An orphan that precedes every loaded prompt. Collected in display order
    // and placed after the loop. Prepending each one as it arrived reversed a
    // whole run: a long automated turn opened on its newest step, with every
    // earlier step above it, filed under whatever later prompt was loaded.
    if (assistantMsg.parentID) {
      const current = partialTurns[partialTurns.length - 1];
      if (current && current.userMessage.info.id === assistantMsg.parentID) {
        current.assistantMessages.push(msg);
      } else {
        partialTurns.push({
          userMessage: unloadedPrompt(assistantMsg.parentID, msg),
          assistantMessages: [msg],
          partial: true,
        });
      }
      continue;
    }
    leadingParentless.push(msg);
  }

  // A parentless orphan (e.g. a session-init failure) attaches to the FIRST
  // turn, so it renders at its real chronological position instead of under
  // an unrelated, much later prompt; with no prompt loaded it opens a
  // synthetic turn of its own.
  if (leadingParentless.length > 0) {
    const first = turns[0] ?? partialTurns[0];
    if (first) {
      first.assistantMessages.unshift(...leadingParentless);
    } else {
      const [opening, ...rest] = leadingParentless;
      turns.push({ userMessage: opening, assistantMessages: rest });
    }
  }

  return partialTurns.length > 0 ? [...partialTurns, ...turns] : turns;
}

/**
 * Stand-ins for prompts the loaded window does not include, by session, id,
 * and the first reply's creation time. Grouping runs on every transcript
 * update, and hosts' stable-turn caches compare messages by reference, so the
 * same window must hand back the same object. Bounded: the oldest entry goes.
 */
const unloadedPrompts = new Map<string, MessageWithPartsLike>();
const UNLOADED_PROMPT_LIMIT = 256;

/** The stand-in for an unloaded prompt: its id, the `user` role, no parts. */
function unloadedPrompt<M extends MessageWithPartsLike>(parentID: string, firstReply: M): M {
  const info = firstReply.info as MessageInfoLike & { sessionID?: string };
  const created = info.time?.created;
  const key = `${info.sessionID ?? ''}|${parentID}|${created ?? ''}`;
  const cached = unloadedPrompts.get(key);
  if (cached) return cached as M;
  const prompt = {
    info: {
      id: parentID,
      role: 'user',
      ...(info.sessionID ? { sessionID: info.sessionID } : {}),
      ...(typeof created === 'number' ? { time: { created } } : {}),
    },
    parts: [],
  } as MessageWithPartsLike;
  if (unloadedPrompts.size >= UNLOADED_PROMPT_LIMIT) {
    const oldest = unloadedPrompts.keys().next().value;
    if (oldest !== undefined) unloadedPrompts.delete(oldest);
  }
  unloadedPrompts.set(key, prompt);
  return prompt as M;
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

