/**
 * When a message was sent, in the two registers a reader actually wants.
 *
 * **The label says how long ago. The hint says exactly when.** Recent messages
 * are easiest to place by distance — "5 days ago" lands immediately, where a
 * date makes you do arithmetic. Past a week that inverts: nobody counts to
 * "23 days ago", so the label becomes the date itself. The precise instant,
 * down to the second, lives one hover away and never clutters the thread.
 *
 * `now` is injected, never read here. Same reason the sibling
 * `session-turn-meta-rows` does it: the wording is a pure function of two
 * instants, so it stays testable, and one render derives every label from a
 * single clock read instead of each row racing its own.
 */

import { formatDistanceStrict } from 'date-fns';

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

const MINUTE = 60_000;
const WEEK = 7 * 24 * 60 * MINUTE;

/** A usable instant, or `null`. One guard, used by both formatters. */
function instant(timestamp: number | null | undefined): Date | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `Intl.DateTimeFormat` construction is the expensive half of formatting — it
 * resolves locale data every time — while the instances themselves are
 * immutable and safe to reuse. A transcript re-renders every label on each
 * clock tick, so building a fresh formatter per label per tick is the one cost
 * here that scales with conversation length. There are only a handful of
 * distinct (locale, options) pairs in this module, so they are all cached.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions, opts: MessageTimeOptions) {
  const resolved = { ...options, ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) };
  const key = `${opts.locale ?? ''}|${JSON.stringify(resolved)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(opts.locale, resolved);
    formatters.set(key, cached);
  }
  return cached;
}

/**
 * Format, with the day period forced to upper case.
 *
 * `Intl` does not agree with itself here: CLDR gives `en-US` an uppercase
 * "PM" but hands `en-AU` a lowercase "pm" — so the same code renders
 * "2:32 PM" for one reader and "2:32 pm" for another, with nothing in this
 * file to explain the difference. Uppercasing the one token settles it without
 * touching month names, weekday names, or the 24-hour locales that have no day
 * period at all.
 *
 * `formatToParts(...).join('')` reproduces `format()` exactly, so this is the
 * same string with one token changed — not a reimplementation of formatting.
 */
function part(date: Date, options: Intl.DateTimeFormatOptions, opts: MessageTimeOptions): string {
  return formatter(options, opts)
    .formatToParts(date)
    .map((token) => (token.type === 'dayPeriod' ? dayPeriod(token.value, opts) : token.value))
    .join('');
}

/**
 * CLDR also drifts on punctuation, not just case: depending on the ICU
 * version, `en-CA` hands out "p.m." where `en-US` gives "PM" — dots included.
 * Every Latin a.m./p.m. variant collapses to the same two letters; day
 * periods in other scripts keep their own convention, uppercased as before.
 */
function dayPeriod(value: string, opts: MessageTimeOptions): string {
  const latin = /^([ap])\.?\s?m\.?$/i.exec(value.trim());
  if (latin) return `${latin[1]!.toUpperCase()}M`;
  return value.toLocaleUpperCase(opts.locale);
}

/** The calendar year at an instant, in the render zone — so "same year" is
 *  asked in the zone the date is printed in, not the runtime's. */
function yearIn(date: Date, opts: MessageTimeOptions): string {
  return part(date, { year: 'numeric' }, opts);
}

/**
 * The label on screen.
 *
 * | When            | Reads as (`en-US`) |
 * | --------------- | ------------------ |
 * | under a minute  | `just now`         |
 * | under a week    | `5 days ago`       |
 * | this year       | `June 9`           |
 * | any older       | `June 9, 2025`     |
 *
 * `formatDistanceStrict` rather than the loose variant, matching
 * `session-turn-meta-rows`: `Strict` never rounds up into a vague "about 1
 * minute", and the point of the label is a real distance, not an impression.
 *
 * `now` is `null` for a server render, where distance is unknowable: the
 * server cannot know the viewer's clock, and guessing produces text that
 * changes on hydration. `null` returns the dated form instead, so the string
 * shown before hydration is never *wrong* — only less immediate than it will be.
 *
 * Returns `''` for a timestamp that is absent or unparseable, so the caller can
 * render nothing rather than an `Invalid Date` placeholder.
 */
export function formatMessageDay(
  timestamp: number | null | undefined,
  now: number | null,
  opts: MessageTimeOptions = {},
): string {
  const date = instant(timestamp);
  if (!date) return '';

  const dated = (withYear: boolean) =>
    part(date, { month: 'long', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }, opts);

  if (now === null) return dated(true);

  // A negative gap means the stamp is ahead of this clock — a few seconds of
  // skew between the sandbox and the browser, not a message from the future.
  // Clamping keeps the skew invisible instead of printing "in 3 seconds".
  const elapsed = Math.max(0, now - date.getTime());

  // Under a minute, `formatDistanceStrict` says "8 seconds ago" and then
  // "9 seconds ago" — motion that carries nothing. One word covers it.
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < WEEK) return formatDistanceStrict(date, new Date(now), { addSuffix: true });

  return dated(yearIn(date, opts) !== yearIn(new Date(now), opts));
}

/**
 * The hover label: the full date and the time of day. `June 9, 2026 2:32 PM`.
 *
 * This is where the specifics belong. The label on screen is deliberately
 * loose so the thread stays readable; hovering answers "when exactly" without
 * that answer ever taking up room in the transcript.
 *
 * Minutes, not seconds. A second-level reading looks like it is worth reading
 * and never is — nobody hovers a chat message to learn it landed at :05.
 */
export function formatMessageExact(
  timestamp: number | null | undefined,
  opts: MessageTimeOptions = {},
): string {
  const date = instant(timestamp);
  if (!date) return '';
  const day = part(date, { month: 'long', day: 'numeric', year: 'numeric' }, opts);
  const clock = part(date, { hour: 'numeric', minute: '2-digit' }, opts);
  return `${day} ${clock}`;
}
