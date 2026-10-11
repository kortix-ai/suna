import { describe, expect, test } from 'bun:test';
import {
  initialTriggerScheduleSlot,
  nextTriggerScheduleSlot,
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
    run: null,
    monitorMode: null,
    intervalSeconds: null,
    expectEventWithinSeconds: null,
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
    expect(
      nextTriggerScheduleSlot(schedule(), new Date('2026-07-27T15:00:00.000Z'))?.toISOString(),
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

// A monitor is cataloged like any other trigger, but it has no schedule: the
// observer drains its event log instead. `next_fire_at` must stay NULL so the
// cron sweep — which claims on `trigger_type = 'cron'` — can never see it.
describe('type = "monitor" never schedules', () => {
  const monitor = (overrides: Partial<GitTriggerSpec> = {}): GitTriggerSpec =>
    schedule({
      type: 'monitor',
      cron: null,
      runAt: null,
      timezone: 'UTC',
      run: './monitors/checkout.ts',
      monitorMode: 'stream',
      intervalSeconds: null,
      expectEventWithinSeconds: null,
      sessionMode: 'reuse',
      ...overrides,
    });

  test('claims no initial or next slot', () => {
    expect(initialTriggerScheduleSlot(monitor(), new Date('2026-07-27T14:00:00.000Z'))).toBeNull();
    expect(nextTriggerScheduleSlot(monitor(), new Date('2026-07-27T14:00:00.000Z'))).toBeNull();
  });

  test('its revision tracks the monitor fields', () => {
    const original = triggerScheduleRevision(monitor());
    expect(triggerScheduleRevision(monitor())).toBe(original);
    expect(triggerScheduleRevision(monitor({ run: './monitors/other.ts' }))).not.toBe(original);
    expect(triggerScheduleRevision(monitor({ monitorMode: 'poll', intervalSeconds: 60 }))).not.toBe(
      original,
    );
    expect(triggerScheduleRevision(monitor({ expectEventWithinSeconds: 86_400 }))).not.toBe(
      original,
    );
  });

  // Adding the monitor fields to the hash unconditionally would rewrite every
  // cron/webhook revision on deploy, which re-upserts the catalog row and
  // re-arms already-fired one-off `run_at` triggers fleet-wide.
  test('a cron revision is unchanged by the monitor fields', () => {
    expect(triggerScheduleRevision(schedule({ run: './x.ts', monitorMode: 'poll' }))).toBe(
      triggerScheduleRevision(schedule()),
    );
  });
});

// Characterization: the hash string of an existing trigger must not move when
// the event type lands. A moved revision re-upserts every catalog row.
describe('schedule revision is pinned for non-event types', () => {
  test('cron and webhook revisions equal the pre-event hashes', () => {
    expect(triggerScheduleRevision(schedule())).toBe(
      'c62c42e5c5e7b7b69d399925bf34ff11d22f12c1a62044a72c80e3e502316b75',
    );
    expect(triggerScheduleRevision(schedule({ type: 'webhook' }))).toBe(
      'fca2ff133482b29721769bfaf3e9b4c1b88dbe71c45654f2a32ede10e065f2e5',
    );
  });

  test('an event revision tracks connector, event type and config', () => {
    const event = (config: Record<string, unknown> = {}, type = 'E') =>
      schedule({ type: 'event', cron: null, timezone: 'UTC', event: { connector: 'github', type, config } });
    const original = triggerScheduleRevision(event());
    expect(triggerScheduleRevision(event())).toBe(original);
    expect(triggerScheduleRevision(event({ repo: 'api' }))).not.toBe(original);
    expect(triggerScheduleRevision(event({}, 'OTHER'))).not.toBe(original);
  });

  test('an event revision tracks the account only when one is set', () => {
    const event = (account?: string | null) =>
      schedule({ type: 'event', cron: null, timezone: 'UTC', event: { connector: 'github', ...(account === undefined ? {} : { account }), type: 'E', config: {} } });
    const original = triggerScheduleRevision(event());
    expect(triggerScheduleRevision(event('acme-bot'))).not.toBe(original);
    expect(triggerScheduleRevision(event('acme-bot'))).not.toBe(triggerScheduleRevision(event('other-bot')));
  });

  test('an event with no account keeps the revision it had before accounts existed', () => {
    // Characterization: a changed revision re-upserts the catalog row of every existing event trigger.
    expect(
      triggerScheduleRevision(schedule({ type: 'event', cron: null, timezone: 'UTC', event: { connector: 'github', type: 'E', config: {} } })),
    ).toBe('aebeec2d7fd43e59cd497b5d0fcb86933ad38c51c7316cc755252d702c520fbf');
  });
});

// KRTX-1721: croner reads a 6-field cron seconds-first, so a cron that steps
// the first field fires every few seconds, and each fire starts a session.
// New crons are refused at write time; a stored one runs at most once a minute.
describe('a stored cron that fires more than once a minute', () => {
  const at = new Date('2026-07-27T10:00:00.000Z');

  test('advances at least 60 seconds past the previous slot', () => {
    for (const cron of ['*/5 * * * * *', '*/30 * * * * *', '0,30 * * * * *']) {
      expect(nextTriggerScheduleSlot(schedule({ cron, timezone: 'UTC' }), at)?.toISOString()).toBe(
        '2026-07-27T10:01:00.000Z',
      );
    }
  });

  test('keeps its floor with jitter', () => {
    const next = nextTriggerScheduleSlot(schedule({ cron: '*/5 * * * * *', timezone: 'UTC' }), at, {
      jitterKey: 'trigger-a',
      jitterWindowMs: 60_000,
    });
    expect(next!.getTime() - at.getTime()).toBeGreaterThanOrEqual(60_000);
  });

  test('a once-a-minute cron is unchanged', () => {
    expect(nextTriggerScheduleSlot(schedule({ cron: '0 * * * * *', timezone: 'UTC' }), at)?.toISOString()).toBe(
      '2026-07-27T10:01:00.000Z',
    );
    expect(
      nextTriggerScheduleSlot(schedule({ cron: '0 */30 * * * *', timezone: 'UTC' }), at)?.toISOString(),
    ).toBe('2026-07-27T10:30:00.000Z');
  });
});

describe('type = "event" revision', () => {
  const event = (overrides: NonNullable<GitTriggerSpec['event']>): GitTriggerSpec =>
    schedule({ type: 'event', cron: null, timezone: 'UTC', event: overrides });
  const base = { connector: 'github-work', account: 'acme-bot', type: 'GITHUB_PULL_REQUEST_CREATED', config: { repo: 'acme/api' } };

  // `source` joins the hash only when set, so every event trigger cataloged before `source`
  // existed keeps its revision (a changed revision re-upserts the catalog row).
  test('is unchanged when source is unset and changes when it is set', () => {
    expect(triggerScheduleRevision(event(base))).toBe('b49d4f780a9dcd704633f5a4a9764469846d3b5b19d49796c98ad9e951257bac');
    expect(triggerScheduleRevision(event({ ...base, source: null }))).toBe(triggerScheduleRevision(event(base)));
    expect(triggerScheduleRevision(event({ connector: base.connector, account: base.account, source: 'composio', type: base.type, config: base.config }))).not.toBe(
      triggerScheduleRevision(event(base)),
    );
  });
});
