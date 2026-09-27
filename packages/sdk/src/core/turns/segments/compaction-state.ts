/**
 * What a compaction turn amounts to — pure, so the marker/failed-row
 * decisions in session-chat.tsx have a test that can fail (the component
 * around them needs a DOM and this repo's `bun test` has none).
 *
 * A turn is a COMPACTION turn when a summary message is present. Usually that
 * is an assistant message carrying the runtime's `summary: true` flag — but a
 * summary message with NO user prompt to attach to becomes a SYNTHETIC turn
 * (`groupMessagesIntoTurns`): the summary message IS `turn.userMessage` and
 * `assistantMessages` is empty. Scanning only `assistantMessages` missed
 * those, so each failed attempt rendered as an EMPTY normal turn — a 0px
 * TurnViewport whose `contain-intrinsic-size: auto 600px` ballooned to a
 * 600px blank block whenever `content-visibility` skipped it.
 *
 * It HAS CONTENT when a `compaction` part exists or a summary message has
 * non-whitespace text. `inFlight` means a summary message is neither
 * completed nor errored — the message-state half of "is this running", which
 * the working projection cannot see (compaction "is not a turn" to it).
 * `error` is the first summary message's raw error, needed because
 * `getTurnError` also reads only `assistantMessages` and so reports nothing
 * for a synthetic turn.
 */

export interface CompactionTurnInfo {
  isCompaction: boolean;
  hasContent: boolean;
  inFlight: boolean;
  /** Raw `info.error` of the first errored summary message, else null. */
  error: unknown;
}

interface MessageLike {
  info: unknown;
  parts?: ReadonlyArray<{ type: string; text?: string }>;
}

/** Minimal structural shape — the SDK turn types satisfy it. */
interface CompactionTurnLike {
  userMessage?: MessageLike;
  assistantMessages: ReadonlyArray<MessageLike>;
}

interface SummaryInfoLike {
  summary?: boolean;
  error?: unknown;
  time?: { completed?: number };
}

export function compactionTurnInfo(turn: CompactionTurnLike): CompactionTurnInfo {
  let isCompaction = false;
  let hasContent = false;
  let inFlight = false;
  let error: unknown = null;

  const scanSummaryInfo = (raw: unknown): boolean => {
    const info = raw as SummaryInfoLike | null | undefined;
    if (info?.summary !== true) return false;
    isCompaction = true;
    if (!info.time?.completed && !info.error) inFlight = true;
    if (error == null && info.error != null) error = info.error;
    return true;
  };
  const scanParts = (parts: MessageLike['parts']): void => {
    for (const part of parts ?? []) {
      if (part.type === 'compaction') {
        isCompaction = true;
        hasContent = true;
      } else if (part.type === 'text' && part.text?.trim()) {
        hasContent = true;
      }
    }
  };

  // The REQUEST marker: opencode's `SessionCompaction.create` mints a user
  // message whose only part is `type: "compaction"` — present from the moment
  // an attempt starts, success or failure. It marks the turn as a compaction
  // but is NOT content (it exists for attempts that summarised nothing) —
  // that is what lets a failed attempt whose error landed on a PLAIN
  // assistant message (the loop died before minting the summary-flagged one)
  // still classify as a failed compaction instead of a bare error turn.
  const userParts = turn.userMessage?.parts ?? [];
  const hasRequestMarker = userParts.some((p) => p.type === 'compaction');
  if (hasRequestMarker) isCompaction = true;

  // The synthetic-turn case: a summary message with no user prompt to attach
  // to becomes the turn's userMessage. Its TEXT only counts under the summary
  // flag, so a real user prompt's text can never count as summary content.
  if (turn.userMessage && scanSummaryInfo(turn.userMessage.info)) {
    scanParts(turn.userMessage.parts);
  }

  for (const msg of turn.assistantMessages) {
    scanSummaryInfo(msg.info);
    scanParts(msg.parts);
  }

  // Request accepted, reply not minted yet: the marker exists but no
  // assistant message does — the gap between the compaction user message
  // arriving and the summary message starting. Without this the turn reads
  // "failed" for those frames and the failed row flickers in at stream start.
  if (hasRequestMarker && turn.assistantMessages.length === 0) inFlight = true;

  return { isCompaction, hasContent, inFlight, error };
}
