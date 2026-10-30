import type { UiTranslator } from '../../i18n';
import type { ProjectTrigger } from '@kortix/sdk';

/**
 * The trigger clock's health tones and its "last run" label. The Triggers list
 * (`customize/triggers/schedule`) and the session reminders panel
 * (`session/panel`) both draw them, so they sit below both layers.
 */

export type ClockState = 'ok' | 'failed' | 'needs_connection' | 'pending' | 'paused' | 'never';

const GREEN = { reflection: 'text-kortix-green', dot: 'bg-kortix-green' } as const;
const RED = { reflection: 'text-kortix-red', dot: 'bg-kortix-red' } as const;
const YELLOW = { reflection: 'text-kortix-yellow', dot: 'bg-kortix-yellow' } as const;

/**
 * ONE tone per state drives both the reflection and the dot, so they cannot
 * disagree. Three colours, always full strength: green = live (running, ran,
 * or not run yet), red = failed, yellow = paused or waiting on setup.
 */
export const CLOCK_TONE = {
  ok: GREEN,
  never: GREEN,
  failed: RED,
  needs_connection: YELLOW,
  pending: YELLOW,
  paused: YELLOW,
} as const satisfies Record<ClockState, { reflection: string; dot: string }>;

/** "2d ago", "9h ago", "3w ago" in the viewer's locale, or "Never run". */
export function lastRunLabel(
  trigger: Pick<ProjectTrigger, 'last_fired_at' | 'event'>,
  t: UiTranslator,
  locale: string,
  now: number = Date.now(),
): string {
  const iso = trigger.last_fired_at ?? trigger.event?.last_event_at ?? null;
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return t.raw('text3d40a69d3160');
  const rtf = new Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'auto' });
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return rtf.format(0, 'second');
  if (min < 60) return rtf.format(-min, 'minute');
  if (min < 24 * 60) return rtf.format(-Math.floor(min / 60), 'hour');
  if (min < 7 * 24 * 60) return rtf.format(-Math.floor(min / (24 * 60)), 'day');
  return rtf.format(-Math.floor(min / (7 * 24 * 60)), 'week');
}
