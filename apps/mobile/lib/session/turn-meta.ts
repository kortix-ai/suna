/**
 * A finished turn's details — when it finished, how long it took, what it
 * cost, how many tokens it used. A port of apps/web
 * `features/session/session-turn-meta-rows.ts`, rendered by
 * `components/session/turn/session-turn-meta.tsx`.
 *
 * `now` is injected, never read here, so the "N ago" wording is testable.
 */

import { formatCost, formatDuration, formatTokens } from '@kortix/sdk';
import type { MessageWithParts, Turn } from '@/lib/opencode/types';

/** The web popover's labels (apps/web translations/en.json). */
export const TURN_META_LABELS = {
  finished: 'Finished',
  duration: 'Duration',
  cost: 'Cost',
  tokens: 'Tokens',
} as const;

export interface TurnMetaCost {
  cost: number;
  tokens: { input: number; output: number };
}

export interface TurnMetaRow {
  label: string;
  value: string;
}

/** `time` lives on the user and assistant arms of the message union, not on `info` itself. */
function messageTime(message: MessageWithParts | undefined): { created?: number; completed?: number } {
  return (message?.info as { time?: { created?: number; completed?: number } } | undefined)?.time ?? {};
}

function turnSpan(turn: Turn): { startedAt: number | null; endedAt: number | null } {
  const startedAt = messageTime(turn.userMessage).created ?? null;
  const lastAssistant = turn.assistantMessages[turn.assistantMessages.length - 1];
  const lastTime = messageTime(lastAssistant);
  return { startedAt, endedAt: lastTime.completed ?? lastTime.created ?? null };
}

/** The last assistant message's `completed` stamp, else its `created` stamp. */
export function turnEndedAt(turn: Turn): number | null {
  return turnSpan(turn).endedAt;
}

/** User prompt → turn end. `null` when unknown or a same-instant span. */
export function turnDurationMs(turn: Turn): number | null {
  const { startedAt, endedAt } = turnSpan(turn);
  if (startedAt == null || endedAt == null || endedAt <= startedAt) return null;
  return endedAt - startedAt;
}

const MS_IN_MINUTE = 60_000;
const MINUTES_IN_DAY = 1_440;
const MINUTES_IN_MONTH = 43_200;
const MINUTES_IN_YEAR = 525_600;

/** date-fns `getTimezoneOffsetInMilliseconds`. */
function zoneOffsetMs(date: Date): number {
  const utc = new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds(),
    ),
  );
  utc.setUTCFullYear(date.getFullYear());
  return date.getTime() - utc.getTime();
}

/** date-fns `getRoundingMethod('round')`: Math.round without negative zero. */
function round(value: number): number {
  const result = Math.round(value);
  return result === 0 ? 0 : result;
}

/**
 * date-fns 3.6 `formatDistanceStrict(date, now, { addSuffix: true })` for the
 * en-US locale — the exact wording of web's "Finished" row. Mobile carries no
 * date library, so the algorithm is ported: same unit thresholds, same
 * rounding, same DST normalisation for days/months/years.
 */
export function formatDistanceStrictAgo(date: number, now: number): string {
  const comparison = date > now ? 1 : date < now ? -1 : 0;
  const left = new Date(comparison > 0 ? now : date);
  const right = new Date(comparison > 0 ? date : now);
  const milliseconds = right.getTime() - left.getTime();
  const minutes = milliseconds / MS_IN_MINUTE;
  const dstNormalizedMinutes =
    (milliseconds - (zoneOffsetMs(right) - zoneOffsetMs(left))) / MS_IN_MINUTE;

  let count: number;
  let unit: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';
  if (minutes < 1) {
    unit = 'second';
    count = round(milliseconds / 1000);
  } else if (minutes < 60) {
    unit = 'minute';
    count = round(minutes);
  } else if (minutes < MINUTES_IN_DAY) {
    unit = 'hour';
    count = round(minutes / 60);
  } else if (dstNormalizedMinutes < MINUTES_IN_MONTH) {
    unit = 'day';
    count = round(dstNormalizedMinutes / MINUTES_IN_DAY);
  } else if (dstNormalizedMinutes < MINUTES_IN_YEAR) {
    const months = round(dstNormalizedMinutes / MINUTES_IN_MONTH);
    unit = months === 12 ? 'year' : 'month';
    count = months === 12 ? 1 : months;
  } else {
    unit = 'year';
    count = round(dstNormalizedMinutes / MINUTES_IN_YEAR);
  }

  const phrase = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return comparison > 0 ? `in ${phrase}` : `${phrase} ago`;
}

/**
 * The rows in display order. A row is omitted, never zero-filled: no end → no
 * Finished; sub-second duration → no Duration; zero cost → no Cost; zero
 * input + output tokens → no Tokens.
 */
export function turnMetaRows(input: {
  endedAt: number | null;
  now: number;
  durationMs: number | null;
  cost: TurnMetaCost | null | undefined;
}): TurnMetaRow[] {
  const rows: TurnMetaRow[] = [];
  const { endedAt, now, durationMs, cost } = input;

  if (endedAt != null) {
    rows.push({ label: TURN_META_LABELS.finished, value: formatDistanceStrictAgo(endedAt, now) });
  }
  if (durationMs != null) {
    const value = formatDuration(durationMs);
    if (value) rows.push({ label: TURN_META_LABELS.duration, value });
  }
  if (cost && cost.cost > 0) {
    rows.push({ label: TURN_META_LABELS.cost, value: formatCost(cost.cost) });
  }
  const tokenTotal = cost ? cost.tokens.input + cost.tokens.output : 0;
  if (cost && tokenTotal > 0) {
    rows.push({ label: TURN_META_LABELS.tokens, value: formatTokens(tokenTotal) });
  }
  return rows;
}
