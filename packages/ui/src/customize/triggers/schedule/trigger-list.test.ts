import type { ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '../../../test-utils/intl';

import { lastRunLabel, nextRunLabel } from './trigger-list';

const t = testUiTranslator;
// 2026-10-17 is a Saturday.
const now = new Date(2026, 9, 17, 10, 0).getTime();
const cron = (next: Date | null, enabled = true) =>
  ({ type: 'cron', enabled, next_fire_at: next?.toISOString() ?? null }) as Pick<
    ProjectTrigger,
    'type' | 'enabled' | 'next_fire_at'
  >;

describe('nextRunLabel (C09 trailing, line one)', () => {
  test('today: the time alone', () => {
    expect(nextRunLabel(cron(new Date(2026, 9, 17, 14, 45)), t, 'en-GB', now)).toMatch(/^next 14:45:00 .+/);
  });
  test('this week: the weekday and time', () => {
    expect(nextRunLabel(cron(new Date(2026, 9, 19, 9, 0)), t, 'en-GB', now)).toMatch(/^next Mon 09:00:00 .+/);
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

test('the list labels the exact six-field cron boundary, not jittered execution', () => {
  expect(nextRunLabel({ type: 'cron', enabled: true,
    next_cron_at: '2026-10-17T14:00:00Z', next_fire_at: '2026-10-17T14:15:00Z',
  }, t, 'en-GB', now)).toBe('next 14:00:00 UTC');
});
