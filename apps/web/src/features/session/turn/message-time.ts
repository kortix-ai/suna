/**
 * When a message was sent, as a string a person can read at a glance.
 *
 * A transcript is a log, and a log without timestamps can only be read
 * relatively — "this came after that". Scroll back an hour and there is nothing
 * on screen that says *when*. This module turns `info.time.created` into the
 * one line that answers it.
 *
 * Two rules shape everything below:
 *
 * 1. **Absolute, not relative.** "5m ago" has to tick to stay true, and a
 *    transcript can hold hundreds of messages — that is hundreds of intervals
 *    re-rendering hundreds of rows to move a digit. A clock reading is correct
 *    the moment it is printed and stays correct forever.
 * 2. **`now` is injected, never read here.** Same reason the sibling
 *    `session-turn-meta-rows` does it: the "Yesterday" wording is a pure
 *    function of two instants, so it stays testable, and one render derives
 *    every label from a single clock read instead of each row racing its own.
 */

import type { MessageWithParts } from '@/ui';

/**
 * `Message` is a union whose user and assistant arms carry different `time`
 * shapes, and neither is on the shared `info` type — so `info.time` does not
 * typecheck against the union. This narrow accessor is the one place that cast
 * lives; `session-turn-meta-rows` imports it rather than keeping a second copy.
 */
export function messageTime(message: MessageWithParts | undefined): {
  created?: number;
  completed?: number;
} {
  return (
    (message?.info as { time?: { created?: number; completed?: number } } | undefined)?.time ?? {}
  );
}

/**
 * When the message was created, in epoch **milliseconds**, or `null` when the
 * backend never stamped one.
 *
 * Milliseconds is not an assumption: `packages/sdk/src/transcript.ts` feeds the
 * same field straight to `new Date(...)` with no `* 1000`, and hands
 * `time.completed - time.created` to a `formatDuration(ms)`.
 *
 * `0` is rejected along with `NaN`: the epoch is not a plausible message time,
 * so a zeroed field is missing data, not midnight in 1970.
 */
export function messageCreatedAt(message: MessageWithParts | undefined): number | null {
  const created = messageTime(message).created;
  if (typeof created !== 'number' || !Number.isFinite(created) || created <= 0) return null;
  return created;
}

export interface MessageTimeOptions {
  /**
   * IANA zone to render in. Omit for the viewer's own zone — which is what the
   * browser should use, and exactly what a server render must NOT, since the
   * server's zone is its own and the resulting text would not survive
   * hydration.
   */
  timeZone?: string;
  /**
   * BCP-47 locale. Omit for the viewer's own — it decides 12- vs 24-hour, which
   * is the whole reason not to hardcode `en-US` on the client.
   */
  locale?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * The calendar date at an instant, *in a given zone*, as `YYYY-MM-DD`.
 *
 * The zone matters: "is this today?" has to be asked in the same zone the clock
 * face is printed in, or a message stamped 23:40 local reads as "Yesterday"
 * next to a 23:40 time. `en-CA` is used purely because it yields ISO order.
 */
function civilDate(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** `YYYY-MM-DD` → days since the epoch. Subtracting two of these gives a whole
 *  number of calendar days apart with no DST arithmetic to get wrong. */
function civilDayIndex(civil: string): number {
  const [year, month, day] = civil.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function part(date: Date, options: Intl.DateTimeFormatOptions, opts: MessageTimeOptions): string {
  return new Intl.DateTimeFormat(opts.locale, {
    ...options,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  }).format(date);
}

const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/**
 * How the timestamp reads, scoped to how far back it is.
 *
 * | When            | Reads as (`en-US`)       |
 * | --------------- | ------------------------ |
 * | today           | `2:34 PM`                |
 * | yesterday       | `Yesterday 2:34 PM`      |
 * | within the week | `Tue 2:34 PM`            |
 * | this year       | `Aug 12, 2:34 PM`        |
 * | any older       | `Aug 12, 2025, 2:34 PM`  |
 *
 * Field *order* is the locale's, not ours — `Intl` puts the day first for
 * `en-GB` and the month first for `en-US`, and both are right for their reader.
 * Only the field *set* is chosen here.
 *
 * The ladder exists because precision is only worth the pixels it earns. Inside
 * today the date is noise — every message shares it. A week out the weekday is
 * the fastest way to place a message. Past that, only the date means anything.
 *
 * `now` is `null` for a server render, where "today" is unknowable: the server
 * cannot know the viewer's zone, and guessing produces text that changes on
 * hydration. `null` returns the unambiguous full form instead, so the string
 * shown before hydration is never *wrong* — only longer than it will be.
 *
 * Returns `''` for a timestamp that is absent or unparseable, so the caller can
 * render nothing rather than a `Invalid Date` placeholder.
 */
export function formatMessageTime(
  timestamp: number | null | undefined,
  now: number | null,
  opts: MessageTimeOptions = {},
): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  const time = part(date, TIME, opts);

  if (now === null) {
    return `${part(date, { day: 'numeric', month: 'short', year: 'numeric' }, opts)}, ${time}`;
  }

  const thenCivil = civilDate(date, opts.timeZone);
  const nowCivil = civilDate(new Date(now), opts.timeZone);
  const days = civilDayIndex(nowCivil) - civilDayIndex(thenCivil);

  // A negative gap means the stamp is ahead of this clock — a few seconds of
  // skew between the sandbox and the browser, not a message from tomorrow.
  // Clamping to "today" keeps the skew invisible instead of printing a future.
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${part(date, { weekday: 'short' }, opts)} ${time}`;

  const sameYear = thenCivil.slice(0, 4) === nowCivil.slice(0, 4);
  const day = part(
    date,
    { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) },
    opts,
  );
  return `${day}, ${time}`;
}

/**
 * The unabbreviated reading, for the `title` tooltip — the timestamp on screen
 * is deliberately short, and hovering is where "which Tuesday?" gets answered.
 */
export function formatMessageTimeFull(
  timestamp: number | null | undefined,
  opts: MessageTimeOptions = {},
): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return part(
    date,
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...TIME },
    opts,
  );
}
