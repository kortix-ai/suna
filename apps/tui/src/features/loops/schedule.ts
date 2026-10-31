/**
 * The schedule line of the create form, as the SDK's `CreateSessionReminderInput`
 * takes it (`packages/sdk/src/core/rest/projects-client/session-reminders.ts`).
 *
 * Grammar, one form per line:
 *   every <duration>     a recurring loop        every 30m
 *   in <duration>        one run, later          in 2h
 *   at <ISO-8601>        one run, at an instant  at 2026-11-02T09:00:00Z
 *   cron <5 fields>      a recurring loop        cron 0 9 * * 1-5
 *
 * A duration is a whole number plus `s`, `m`, `h` or `d`. The API runs a
 * recurring loop at most once per 5 minutes, so a shorter `every` is refused
 * here with the same reason instead of a round trip.
 */

import type { CreateSessionReminderInput } from '@kortix/sdk';

/** The shortest period of a recurring loop. */
export const MIN_EVERY_SECONDS = 300;

export const SCHEDULE_HINT = 'every 30m · in 2h · at 2026-11-02T09:00Z · cron 0 9 * * 1-5';

export type ScheduleParse =
  | { ok: true; schedule: Pick<CreateSessionReminderInput, 'every' | 'in' | 'at' | 'cron'> }
  | { ok: false; reason: string };

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** `30m` → 1800. `null` when `text` is not a duration. */
export function durationSeconds(text: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(text.trim().toLowerCase());
  if (!match) return null;
  return Number(match[1]) * (UNIT_SECONDS[match[2] as string] as number);
}

export function parseSchedule(input: string): ScheduleParse {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, reason: `Enter a schedule: ${SCHEDULE_HINT}` };
  const space = text.indexOf(' ');
  const word = (space < 0 ? text : text.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : text.slice(space + 1).trim();

  if (word === 'every' || word === 'in') {
    const seconds = durationSeconds(rest);
    if (seconds === null || seconds <= 0)
      return { ok: false, reason: `"${rest}" is not a duration. Use 30m, 2h, 1d.` };
    if (word === 'every') {
      if (seconds < MIN_EVERY_SECONDS)
        return { ok: false, reason: 'A loop runs at most once every 5m.' };
      return { ok: true, schedule: { every: rest.toLowerCase() } };
    }
    return { ok: true, schedule: { in: rest.toLowerCase() } };
  }
  if (word === 'at') {
    if (Number.isNaN(Date.parse(rest)))
      return { ok: false, reason: `"${rest}" is not a date. Use 2026-11-02T09:00Z.` };
    return { ok: true, schedule: { at: rest } };
  }
  if (word === 'cron') {
    if (rest.split(' ').length !== 5)
      return { ok: false, reason: 'A cron expression has 5 fields: 0 9 * * 1-5.' };
    return { ok: true, schedule: { cron: rest } };
  }
  return { ok: false, reason: `Start with every, in, at or cron: ${SCHEDULE_HINT}` };
}
