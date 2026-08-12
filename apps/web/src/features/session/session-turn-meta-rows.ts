/**
 * Pure derivation of a turn's "when did this finish, how long did it take,
 * what did it cost" meta — no React, no clock read of its own. `now` is
 * always injected so the "N ago" wording is testable and a re-render derives
 * the whole set from one clock read rather than each row racing its own.
 */

import { formatCost, formatDuration, formatTokens } from '@/ui';
import type { Turn, TurnCostInfo } from '@/ui';
import { formatDistanceStrict } from 'date-fns';

// The narrow accessor for the `Message` union's `time` field lives in
// `turn/message-time` — the same one the user bubble's timestamp reads through,
// so there is exactly one place that knows how to get a stamp off a message.
import { messageTime } from './turn/message-time';

export interface SessionTurnSpan {
  startedAt: number | null;
  endedAt: number | null;
}

/** A turn's wall-clock bounds: when the user's prompt landed, and when the
 *  agent last produced something for it. `endedAt` prefers the last assistant
 *  message's `completed` stamp — the point the response was actually done —
 *  and falls back to `created` for a message that never got one (e.g. it was
 *  interrupted before finishing). */
export function sessionTurnSpan(turn: Turn): SessionTurnSpan {
  const startedAt = messageTime(turn.userMessage).created ?? null;
  const lastAssistant = turn.assistantMessages[turn.assistantMessages.length - 1];
  const lastTime = messageTime(lastAssistant);
  const endedAt = lastTime.completed ?? lastTime.created ?? null;
  return { startedAt, endedAt };
}

export function sessionTurnEndedAt(turn: Turn): number | null {
  return sessionTurnSpan(turn).endedAt;
}

/** How long the turn took. `null` whenever that isn't knowable, INCLUDING
 *  `endedAt === startedAt`: one timestamp says WHEN a turn ended and says
 *  nothing about how long it took to get there, so a same-instant span is
 *  treated the same as no span at all rather than rendered as "0s". */
export function sessionTurnDurationMs(turn: Turn): number | null {
  const { startedAt, endedAt } = sessionTurnSpan(turn);
  if (startedAt == null || endedAt == null || endedAt <= startedAt) return null;
  return endedAt - startedAt;
}

export interface SessionTurnMetaRow {
  label: string;
  value: string;
}

/**
 * The turn's meta as labelled rows, in display order. A row is omitted
 * rather than rendered with a fabricated "$0.00" or "0 tokens" whenever the
 * underlying value is absent or zero — the guards below exist so a turn that
 * did nothing billable simply carries fewer rows, not zeroed-out ones.
 */
export function sessionTurnMetaRows({
  endedAt,
  now,
  durationMs,
  cost,
}: {
  endedAt: number | null;
  now: number;
  durationMs: number | null;
  cost: TurnCostInfo | null | undefined;
}): SessionTurnMetaRow[] {
  const rows: SessionTurnMetaRow[] = [];

  if (endedAt != null) {
    rows.push({
      label: 'Finished',
      // `Strict` never rounds up to a vague "about 1 minute" — the whole
      // point of this row is a precise *when*, not an approximation.
      value: formatDistanceStrict(endedAt, now, { addSuffix: true }),
    });
  }

  if (durationMs != null) {
    const value = formatDuration(durationMs);
    // formatDuration returns '' for sub-second durations — that's the
    // formatter's own "nothing worth showing" signal, so honor it here too.
    if (value) rows.push({ label: 'Duration', value });
  }

  // `formatCost(0)` renders as "$0.00" — a real-looking number for a turn
  // that spent nothing — so the row is gated on the raw value, not the string.
  if (cost && cost.cost > 0) {
    rows.push({ label: 'Cost', value: formatCost(cost.cost) });
  }

  // Deliberately `input + output` only, NOT every token field: `reasoning` /
  // `cacheRead` / `cacheWrite` are real counts, but a cache-read number far
  // bigger than the visible conversation would raise a question this single
  // row can't answer. A turn can be reasoning- or cache-heavy and legitimately
  // carry no Tokens row.
  const tokenTotal = cost ? cost.tokens.input + cost.tokens.output : 0;
  if (cost && tokenTotal > 0) {
    rows.push({ label: 'Tokens', value: formatTokens(tokenTotal) });
  }

  return rows;
}
