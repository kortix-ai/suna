import { describe, expect, test } from 'bun:test';
import {
  advanceTriggerScheduleSlot,
  initialTriggerScheduleSlot,
  triggerScheduleRevision,
  validateTriggerCron,
  validateTriggerTimezone,
} from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

function schedule(overrides: Partial<GitTriggerSpec> = {}): GitTriggerSpec {
  return {
    slug: 'morning-email',
    path: 'kortix.yaml#triggers.morning-email',
    name: 'Morning email',
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    promptTemplate: 'Prepare the email',
    cron: '0 0 8 * * *',
    runAt: null,
    timezone: 'America/Los_Angeles',
    secretEnv: null,
    sessionMode: 'fresh',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
    ...overrides,
  };
}

describe('trigger schedule validation', () => {
  test('accepts a six-field cron and canonical IANA timezone', () => {
    expect(validateTriggerTimezone('America/Los_Angeles')).toBeNull();
    expect(validateTriggerCron('0 0 8 * * *', 'America/Los_Angeles')).toBeNull();
    expect(validateTriggerCron('0 8 * * *', 'America/Los_Angeles')).toBeNull();
  });

  test('rejects ambiguous timezone abbreviations and invalid cron fields', () => {
    expect(validateTriggerTimezone('PST')).toContain('valid IANA name');
    expect(validateTriggerCron('0 0 25 * * *', 'America/Los_Angeles')).toContain(
      'invalid cron expression',
    );
  });
});

describe('materialized next_fire_at', () => {
  test('a new recurring schedule waits for its next slot instead of firing immediately', () => {
    const createdAt = new Date('2026-07-27T08:55:00.000Z');
    expect(initialTriggerScheduleSlot(schedule(), createdAt)?.toISOString()).toBe(
      '2026-07-27T15:00:00.000Z',
    );
  });

  test('the common five-field form also resolves 8 AM Los Angeles exactly', () => {
    const createdAt = new Date('2026-07-27T08:55:00.000Z');
    expect(
      initialTriggerScheduleSlot(schedule({ cron: '0 8 * * *' }), createdAt)?.toISOString(),
    ).toBe('2026-07-27T15:00:00.000Z');
  });

  test('a schedule created after the daily slot waits until the next day', () => {
    const createdAt = new Date('2026-07-27T15:01:00.000Z');
    expect(initialTriggerScheduleSlot(schedule(), createdAt)?.toISOString()).toBe(
      '2026-07-28T15:00:00.000Z',
    );
  });

  test('America/Los_Angeles follows daylight-saving transitions', () => {
    expect(
      initialTriggerScheduleSlot(schedule(), new Date('2026-03-07T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-03-07T16:00:00.000Z');
    expect(
      initialTriggerScheduleSlot(schedule(), new Date('2026-03-08T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-03-08T15:00:00.000Z');
    expect(
      initialTriggerScheduleSlot(schedule(), new Date('2026-11-01T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-11-01T16:00:00.000Z');
  });

  test('one-off schedules fire once and recurring schedules advance from the slot', () => {
    const oneOff = schedule({
      cron: null,
      runAt: '2026-07-27T15:00:00.000Z',
    });
    expect(
      initialTriggerScheduleSlot(oneOff, new Date('2026-07-27T14:00:00.000Z'))?.toISOString(),
    ).toBe('2026-07-27T15:00:00.000Z');
    expect(
      initialTriggerScheduleSlot(oneOff, new Date('2026-07-27T16:00:00.000Z'))?.toISOString(),
    ).toBe('2026-07-27T15:00:00.000Z');
    expect(advanceTriggerScheduleSlot(oneOff, new Date('2026-07-27T15:00:00.000Z'))).toBeNull();
    expect(
      advanceTriggerScheduleSlot(schedule(), new Date('2026-07-27T15:00:00.000Z'))?.toISOString(),
    ).toBe('2026-07-28T15:00:00.000Z');
  });
});

describe('schedule revision', () => {
  test('is stable for the same config and changes for schedule or execution inputs', () => {
    const original = triggerScheduleRevision(schedule());
    expect(triggerScheduleRevision(schedule())).toBe(original);
    expect(triggerScheduleRevision(schedule({ cron: '0 0 9 * * *' }))).not.toBe(original);
    expect(triggerScheduleRevision(schedule({ promptTemplate: 'Different prompt' }))).not.toBe(
      original,
    );
    expect(triggerScheduleRevision(schedule({ enabled: false }))).not.toBe(original);
    expect(
      triggerScheduleRevision(schedule({ filter: { 'body.z': 'last', 'body.a': 'first' } })),
    ).toBe(triggerScheduleRevision(schedule({ filter: { 'body.a': 'first', 'body.z': 'last' } })));
  });
});
