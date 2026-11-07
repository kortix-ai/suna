import type { ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '../../../test-utils/intl';

import { lastRunLabel, nextRunIn } from '../../../internal/lib/trigger-clock';
import { nextRunLabel } from './trigger-list';

const t = testUiTranslator;
// 2026-10-17 is a Saturday.
const now = new Date(2026, 9, 17, 10, 0).getTime();
const cron = (next: Date | null, enabled = true) =>
  ({ type: 'cron', enabled, next_fire_at: next?.toISOString() ?? null }) as Pick<
    ProjectTrigger,
    'type' | 'enabled' | 'next_fire_at'
  >;

const MIN = 60_000;
const at = (ms: number) => cron(new Date(now + ms));

describe('nextRunLabel (C09 trailing, line one)', () => {
  test('a schedule counts down in minutes, then hours, then days (KRTX-4380)', () => {
    expect(nextRunLabel(at(5 * MIN), t, 'en', now)).toBe('next in 5 minutes');
    expect(nextRunLabel(at(3 * 60 * MIN), t, 'en', now)).toBe('next in 3 hours');
    expect(nextRunLabel(at(2 * 24 * 60 * MIN), t, 'en', now)).toBe('next in 2 days');
  });
  test('one unit reads singular and numeric: never "tomorrow" or "this minute"', () => {
    expect(nextRunLabel(at(MIN), t, 'en', now)).toBe('next in 1 minute');
    expect(nextRunLabel(at(60 * MIN), t, 'en', now)).toBe('next in 1 hour');
    expect(nextRunLabel(at(24 * 60 * MIN), t, 'en', now)).toBe('next in 1 day');
  });
  test('a run already due reads in 0 minutes, never a negative countdown', () => {
    expect(nextRunLabel(at(-5 * MIN), t, 'en', now)).toBe('next in 0 minutes');
  });
  test('every event-driven kind reads On event, with no countdown', () => {
    for (const type of ['webhook', 'event', 'app', 'change_request'] as const) {
      // A next_fire_at on an event trigger must not turn into a countdown.
      const label = nextRunLabel({ type, enabled: true, next_fire_at: new Date(now + 5 * MIN).toISOString() }, t, 'en', now);
      expect(label).toBe('On event');
    }
  });
  test('webhooks and app events run on an event; paused reads Paused; unscheduled reads —', () => {
    expect(nextRunLabel({ type: 'webhook', enabled: true, next_fire_at: null }, t, 'en', now)).toBe(
      'On event',
    );
    expect(nextRunLabel(cron(new Date(2026, 9, 19, 9, 0), false), t, 'en', now)).toBe('Paused');
    // An auto-paused trigger (KRTX-1721) reads Paused though its manifest says enabled.
    const autoPaused = { auto_paused_at: '2026-10-19T08:00:00.000Z' };
    expect(nextRunLabel({ ...cron(new Date(2026, 9, 19, 9, 0)), ...autoPaused }, t, 'en', now)).toBe('Paused');
    expect(nextRunLabel({ type: 'webhook', enabled: true, next_fire_at: null, ...autoPaused }, t, 'en', now)).toBe('Paused');
    expect(nextRunLabel(cron(null), t, 'en', now)).toBe('—');
  });
});

describe('lastRunLabel (C09 trailing, line two)', () => {
  const ran = (iso: string | null) =>
    ({ last_fired_at: iso, event: null }) as Pick<ProjectTrigger, 'last_fired_at' | 'event'>;
  test('narrow relative time in the locale', () => {
    expect(lastRunLabel(ran(new Date(now - 2 * 86_400_000).toISOString()), t, 'en', now)).toBe(
      '2d ago',
    );
    expect(lastRunLabel(ran(new Date(now - 9 * 3_600_000).toISOString()), t, 'en', now)).toBe(
      '9h ago',
    );
    expect(lastRunLabel(ran(new Date(now - 21 * 86_400_000).toISOString()), t, 'en', now)).toBe(
      '3w ago',
    );
  });
  test('a trigger that never ran says so', () => {
    expect(lastRunLabel(ran(null), t, 'en', now)).toBe('Never run');
  });
});

describe('nextRunIn (the session reminders panel keeps its narrow style)', () => {
  const narrow = new Intl.RelativeTimeFormat('en', { style: 'narrow', numeric: 'auto' });
  const iso = (ms: number) => new Date(now + ms).toISOString();
  test('minutes, hours, days; no time reads —', () => {
    expect(nextRunIn(iso(25 * MIN), narrow, now)).toBe('in 25m');
    expect(nextRunIn(iso(8 * 60 * MIN), narrow, now)).toBe('in 8h');
    expect(nextRunIn(iso(3 * 24 * 60 * MIN), narrow, now)).toBe('in 3d');
    expect(nextRunIn(null, narrow, now)).toBe('—');
  });
});

test('the list counts down to the exact six-field cron boundary, not jittered execution', () => {
  expect(nextRunLabel({ type: 'cron', enabled: true,
    next_cron_at: new Date(now + 30 * MIN).toISOString(), next_fire_at: new Date(now + 3 * 60 * MIN).toISOString(),
  }, t, 'en', now)).toBe('next in 30 minutes');
});
