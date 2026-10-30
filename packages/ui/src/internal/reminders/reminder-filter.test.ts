import { describe, expect, test } from 'bun:test';
import type { SessionReminder } from '@kortix/sdk';

import { matchesQuery, matchesStatus, matchesTime } from './reminder-filter';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const reminder = (over: Partial<SessionReminder>): SessionReminder => ({
  id: 'reminder.a',
  session_id: 's',
  name: 'Check deploy status',
  prompt: 'Summarize the failed staging jobs.',
  every: '1h',
  every_seconds: 3600,
  cron: null,
  timezone: 'UTC',
  at: null,
  state: 'active',
  next_fire_at: '2026-10-21T12:30:00.000Z',
  last_fired_at: null,
  last_status: null,
  last_error: null,
  created_by: null,
  created_at: null,
  ...over,
});

describe('reminder filters', () => {
  test('status: failed is any state whose last run failed; paused is not active', () => {
    expect(matchesStatus(reminder({ last_status: 'failed', state: 'paused' }), 'failed')).toBe(true);
    expect(matchesStatus(reminder({}), 'failed')).toBe(false);
    expect(matchesStatus(reminder({ state: 'paused' }), 'paused')).toBe(true);
    expect(matchesStatus(reminder({ state: 'paused' }), 'active')).toBe(false);
  });

  test('time windows are by next run, and drop paused reminders', () => {
    expect(matchesTime(reminder({}), 'hour', NOW)).toBe(true);
    expect(matchesTime(reminder({ next_fire_at: '2026-10-21T20:00:00.000Z' }), 'hour', NOW)).toBe(false);
    expect(matchesTime(reminder({ next_fire_at: '2026-10-21T20:00:00.000Z' }), 'day', NOW)).toBe(true);
    expect(matchesTime(reminder({ next_fire_at: '2026-11-10T12:00:00.000Z' }), 'later', NOW)).toBe(true);
    expect(matchesTime(reminder({ next_fire_at: '2026-11-10T12:00:00.000Z' }), 'week', NOW)).toBe(false);
    expect(matchesTime(reminder({ state: 'paused' }), 'week', NOW)).toBe(false);
    expect(matchesTime(reminder({ state: 'paused' }), 'any', NOW)).toBe(true);
  });

  test('query: every word, in any order, across title, prompt and schedule', () => {
    expect(matchesQuery(reminder({}), 'staging deploy', 'Every 1h')).toBe(true);
    expect(matchesQuery(reminder({}), 'every 1h', 'Every 1h')).toBe(true);
    expect(matchesQuery(reminder({}), 'invoice', 'Every 1h')).toBe(false);
    expect(matchesQuery(reminder({}), '   ', 'Every 1h')).toBe(true);
  });
});
