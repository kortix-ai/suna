import { describe, expect, test } from 'bun:test';

import type { ProjectTrigger } from '@kortix/sdk';

import {
  CUSTOM_TIMING_LABEL,
  describeCadence,
  describeConditions,
  describeLastRun,
  describeOneOff,
  describeRunLocation,
  describeSecurity,
  describeWhen,
  matchesQuery,
  triggerName,
  triggerStatus,
} from './schedule-copy';

// `test.each` is deliberately avoided throughout: the repo's `@types/bun`
// does not declare it, and apps/web already carries a known backlog of
// `test.each` typecheck errors. A plain loop around `test()` gives the same
// per-case naming with a clean `tsc --noEmit`.

function trigger(overrides: Partial<ProjectTrigger> = {}): ProjectTrigger {
  return {
    slug: 'daily-digest',
    path: 'kortix.yaml#triggers.daily-digest',
    name: 'Daily digest',
    type: 'cron',
    agent: 'build',
    model: null,
    enabled: true,
    cron: '0 0 9 * * *',
    run_at: null,
    timezone: 'UTC',
    secret_env: null,
    prompt_template: 'Write the digest',
    session_mode: 'fresh',
    session_id: null,
    session_key: null,
    filter: null,
    last_fired_at: null,
    webhook_url: null,
    ...overrides,
  } as ProjectTrigger;
}

describe('describeCadence — cron syntax never reaches the screen', () => {
  const cases: [string, string][] = [
    ['0 */5 * * * *', 'Every 5 minutes'],
    ['0 */1 * * * *', 'Every minute'],
    ['0 30 */2 * * *', 'Every 2 hours at :30'],
    ['0 0 */1 * * *', 'Every hour at :00'],
    ['0 15 * * * *', 'Every hour at :15'],
    ['0 0 9 * * *', 'Every day at 09:00'],
    ['0 5 17 * * *', 'Every day at 17:05'],
    ['0 0 9 * * 1-5', 'Weekdays at 09:00'],
    ['0 0 9 * * 1,2,3,4,5', 'Weekdays at 09:00'],
    ['0 0 9 * * 0,6', 'Weekends at 09:00'],
    ['0 0 9 * * 1', 'Every Monday at 09:00'],
    ['0 30 8 * * 2,4', 'Tue, Thu at 08:30'],
    ['0 0 9 * * 0-6', 'Every day at 09:00'],
    ['0 0 9 1 * *', 'The 1st of each month at 09:00'],
    ['0 0 9 2 * *', 'The 2nd of each month at 09:00'],
    ['0 0 9 3 * *', 'The 3rd of each month at 09:00'],
    ['0 0 9 11 * *', 'The 11th of each month at 09:00'],
    ['0 0 9 21 * *', 'The 21st of each month at 09:00'],
  ];

  for (const [expression, expected] of cases) {
    test(`${expression} reads as "${expected}"`, () => {
      expect(describeCadence(expression)).toBe(expected);
    });
  }

  test('extra whitespace is tolerated', () => {
    expect(describeCadence('  0   0   9   *   *   *  ')).toBe('Every day at 09:00');
  });

  const unreadable = [
    '0 0 9 * 3 *', // a specific month has no plain shape yet
    '0 0 9 * * 9', // out-of-range weekday
    '0 0 25 * * *', // out-of-range hour
    '0 0 9 * *', // 5-field cron
    'not a cron',
    '',
  ];

  for (const expression of unreadable) {
    test(`"${expression}" falls back to the plain label rather than leaking syntax`, () => {
      expect(describeCadence(expression)).toBe(CUSTOM_TIMING_LABEL);
    });
  }

  test('the fallback label itself contains no cron syntax', () => {
    expect(CUSTOM_TIMING_LABEL).not.toMatch(/[*/]/);
  });
});

describe('describeWhen', () => {
  test('a recurring schedule reads as its cadence', () => {
    expect(describeWhen(trigger())).toBe('Every day at 09:00');
  });

  test('a one-off reads as a date, not an ISO string', () => {
    const when = describeWhen(trigger({ cron: null, run_at: '2030-03-05T09:00:00.000Z' }));
    expect(when).toStartWith('Once on ');
    expect(when).not.toContain('T09:00');
  });

  test('an invalid one-off still reads as a sentence', () => {
    expect(describeOneOff('nonsense')).toBe('Runs once');
  });

  test('a webhook reads as an event, not a schedule', () => {
    expect(describeWhen(trigger({ type: 'webhook', cron: null }))).toBe('When a request arrives');
  });
});

describe('triggerName', () => {
  test('uses the given name, trimmed', () => {
    expect(triggerName(trigger({ name: '  Standup  ' }))).toBe('Standup');
  });

  test('an unnamed schedule falls back to when it runs', () => {
    expect(triggerName(trigger({ name: '' }))).toBe('Every day at 09:00');
  });

  test('an unnamed webhook still gets a readable name', () => {
    expect(triggerName(trigger({ name: '', type: 'webhook', cron: null }))).toBe(
      'Untitled webhook',
    );
  });
});

describe('triggerStatus — what it is, not what you can do to it', () => {
  test('enabled reads Active and tints green', () => {
    const status = triggerStatus(true);
    expect(status.label).toBe('Active');
    expect(status.active).toBe(true);
    expect(status.tileClassName).toContain('kortix-green');
    expect(status.iconClassName).toContain('kortix-green');
  });

  test('disabled reads Paused and stays neutral', () => {
    const status = triggerStatus(false);
    expect(status.label).toBe('Paused');
    expect(status.active).toBe(false);
    expect(status.tileClassName).not.toContain('kortix-');
    expect(status.iconClassName).not.toContain('kortix-');
  });
});

describe('describeLastRun', () => {
  const now = Date.parse('2026-08-12T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  const never: (string | null | undefined)[] = [null, undefined, 'not-a-date'];
  for (const iso of never) {
    test(`${String(iso)} reads as Never`, () => {
      expect(describeLastRun(iso, now)).toBe('Never');
    });
  }

  const elapsed: [number, string][] = [
    [30_000, 'Just now'],
    [60_000, '1 minute ago'],
    [12 * 60_000, '12 minutes ago'],
    [60 * 60_000, '1 hour ago'],
    [3 * 60 * 60_000, '3 hours ago'],
    [24 * 60 * 60_000, '1 day ago'],
    [5 * 24 * 60 * 60_000, '5 days ago'],
  ];

  for (const [ms, expected] of elapsed) {
    test(`${ms}ms ago reads as "${expected}"`, () => {
      expect(describeLastRun(ago(ms), now)).toBe(expected);
    });
  }

  test('a clock skew into the future does not print a negative age', () => {
    expect(describeLastRun(new Date(now + 5_000).toISOString(), now)).toBe('Just now');
  });

  test('older than a month falls back to a date, not "400 days ago"', () => {
    const result = describeLastRun(ago(400 * 24 * 60 * 60_000), now);
    expect(result).not.toContain('ago');
    expect(result).toContain('2025');
  });
});

describe('describeRunLocation — no wire words', () => {
  const simple: [ProjectTrigger['session_mode'], string][] = [
    ['fresh', 'Start a new session every time'],
    ['reuse', 'Keep using the same session'],
  ];

  for (const [mode, expected] of simple) {
    test(`${mode} reads as "${expected}"`, () => {
      expect(describeRunLocation(trigger({ session_mode: mode }))).toBe(expected);
    });
  }

  test('a pinned session names the session it loops', () => {
    expect(
      describeRunLocation(trigger({ session_mode: 'pinned', session_id: 'abcdef1234567890' })),
    ).toBe('Always use one session I pick (abcdef12)');
  });

  test('"keyed" never reaches the screen', () => {
    const copy = describeRunLocation(
      trigger({ session_mode: 'keyed', session_key: '{{ body.chat_id }}' }),
    );
    expect(copy).toStartWith('One session per conversation');
    expect(copy).not.toContain('keyed');
  });
});

describe('describeSecurity', () => {
  test('a signing secret reads as Signed and names the secret', () => {
    const state = describeSecurity(trigger({ type: 'webhook', secret_env: 'WEBHOOK_X_SECRET' }));
    expect(state.label).toBe('Signed');
    expect(state.signed).toBe(true);
    expect(state.detail).toContain('WEBHOOK_X_SECRET');
  });

  test('no secret reads as a plain warning, not "unsigned" or "HMAC"', () => {
    const state = describeSecurity(trigger({ type: 'webhook' }));
    expect(state.label).toBe('Not signed');
    expect(state.signed).toBe(false);
    expect(state.detail).toContain('Anyone with this address');
    expect(state.detail).not.toContain('HMAC');
  });
});

describe('describeConditions', () => {
  const cases: [Record<string, string> | null, string][] = [
    [null, 'Runs on every request'],
    [{}, 'Runs on every request'],
    [{ 'body.direction': 'inbound' }, 'Runs when 1 condition matches'],
    [{ a: '1', b: '2' }, 'Runs when 2 conditions match'],
  ];

  for (const [filter, expected] of cases) {
    test(`${JSON.stringify(filter)} reads as "${expected}"`, () => {
      expect(describeConditions(filter)).toBe(expected);
    });
  }
});

describe('matchesQuery — searches what is on screen', () => {
  const row = trigger({ name: 'Daily digest', agent: 'writer' });

  for (const query of ['daily', 'DIGEST', 'writer', 'every day', 'active', 'daily-digest']) {
    test(`"${query}" matches`, () => {
      expect(matchesQuery(row, query)).toBe(true);
    });
  }

  test('an empty query matches everything', () => {
    expect(matchesQuery(row, '   ')).toBe(true);
  });

  test('an unrelated query does not match', () => {
    expect(matchesQuery(row, 'webhook')).toBe(false);
  });

  test('a paused row is findable by its status word', () => {
    expect(matchesQuery(trigger({ enabled: false }), 'paused')).toBe(true);
  });
});
