import { describe, expect, test } from 'bun:test';

import type { ProjectTrigger } from '@kortix/sdk';

import {
  CRON_PRESETS,
  DEFAULT_CRON_EXPR,
  buildCurlExample,
  dailyExprAt,
  describeCron,
  describeRunAt,
  describeSessionStrategy,
  filterToRows,
  generateSecret,
  getTriggerName,
  getTriggerSubtitle,
  matchCronPreset,
  normalizeSecretEnvName,
  relativeTime,
  rowsToFilter,
  sameFilter,
  slugifyName,
} from './cron';

/** Minimal trigger; each test overrides only the fields it exercises. */
function trigger(over: Partial<ProjectTrigger> = {}): ProjectTrigger {
  return {
    slug: 'daily-digest',
    type: 'cron',
    name: '',
    cron: DEFAULT_CRON_EXPR,
    run_at: null,
    timezone: 'UTC',
    enabled: true,
    session_mode: 'fresh',
    session_id: null,
    session_key: null,
    secret_env: null,
    last_fired_at: null,
    ...over,
  } as ProjectTrigger;
}

describe('describeCron', () => {
  test('renders every preset as its human label, never as cron syntax', () => {
    for (const preset of CRON_PRESETS) {
      expect(describeCron(preset.expr)).toBe(preset.label);
    }
  });

  test('tolerates surrounding whitespace', () => {
    expect(describeCron('  0 0 9 * * *  ')).toBe('Daily at 09:00');
  });

  test('describes ad-hoc minute intervals', () => {
    expect(describeCron('0 */7 * * * *')).toBe('Every 7 minutes');
    expect(describeCron('0 */1 * * * *')).toBe('Every 1 minute');
  });

  test('describes ad-hoc hour intervals', () => {
    expect(describeCron('0 0 */3 * * *')).toBe('Every 3 hours');
    expect(describeCron('0 0 */1 * * *')).toBe('Every 1 hour');
  });

  test('describes weekday and weekend shapes, zero-padding the time', () => {
    expect(describeCron('0 30 7 * * *')).toBe('Daily at 07:30');
    expect(describeCron('0 0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeCron('0 5 6 * * 0,6')).toBe('Weekends at 06:05');
    expect(describeCron('0 5 6 * * 6,0')).toBe('Weekends at 06:05');
    expect(describeCron('0 0 9 * * 3')).toBe('At 09:00 on day 3');
  });

  test('returns the raw expression when it matches no known shape', () => {
    expect(describeCron('0 0 9 1 1 *')).toBe('0 0 9 1 1 *');
    expect(describeCron('not a cron')).toBe('not a cron');
    expect(describeCron('0 0 9 * *')).toBe('0 0 9 * *');
    expect(describeCron('')).toBe('');
  });
});

describe('matchCronPreset', () => {
  test('matches each preset expression', () => {
    for (const preset of CRON_PRESETS) {
      expect(matchCronPreset(preset.expr)?.id).toBe(preset.id);
    }
  });

  test('the default expression resolves to the daily preset', () => {
    expect(matchCronPreset(DEFAULT_CRON_EXPR)?.id).toBe('daily');
  });

  test('returns null for a bespoke expression so the raw field opens', () => {
    expect(matchCronPreset('0 17 3 * * 2')).toBeNull();
    expect(matchCronPreset('')).toBeNull();
  });
});

describe('dailyExprAt', () => {
  test('builds a daily expression at the given time', () => {
    expect(dailyExprAt('09:00')).toBe(DEFAULT_CRON_EXPR);
    expect(dailyExprAt('17:30')).toBe('0 30 17 * * *');
  });

  test('strips leading zeros so the result round-trips through describeCron', () => {
    expect(describeCron(dailyExprAt('07:05'))).toBe('Daily at 07:05');
  });

  test('clamps out-of-range values rather than emitting invalid cron', () => {
    expect(dailyExprAt('99:99')).toBe('0 59 23 * * *');
    expect(dailyExprAt('-4:-4')).toBe('0 0 0 * * *');
  });

  test('falls back to the default rather than scheduling at midnight', () => {
    // A blank or garbage time field must not silently mean 00:00.
    expect(dailyExprAt('')).toBe(DEFAULT_CRON_EXPR);
    expect(dailyExprAt('abc:def')).toBe(DEFAULT_CRON_EXPR);
    expect(dailyExprAt('09')).toBe(DEFAULT_CRON_EXPR);
  });
});

describe('getTriggerName', () => {
  test('prefers an explicit name', () => {
    expect(getTriggerName(trigger({ name: '  Morning digest  ' }))).toBe('Morning digest');
  });

  test('falls back to the human cron description, never the raw expression', () => {
    expect(getTriggerName(trigger({ cron: '0 0 9 * * 1-5' }))).toBe('Weekdays at 09:00');
  });

  test('describes a one-off run', () => {
    expect(getTriggerName(trigger({ run_at: '2026-03-04T09:00:00.000Z' }))).toContain('Runs once');
  });

  test('falls back to a type label with no cron and no name', () => {
    expect(getTriggerName(trigger({ cron: null }))).toBe('Cron trigger');
    expect(getTriggerName(trigger({ type: 'webhook', cron: null }))).toBe('Webhook trigger');
  });
});

describe('getTriggerSubtitle', () => {
  test('shows the timezone for a recurring schedule and One-off for a dated run', () => {
    expect(getTriggerSubtitle(trigger({ timezone: 'Europe/Berlin' }))).toBe('Europe/Berlin');
    expect(getTriggerSubtitle(trigger({ run_at: '2026-03-04T09:00:00.000Z' }))).toBe('One-off');
  });

  test('reports webhook signing state', () => {
    expect(getTriggerSubtitle(trigger({ type: 'webhook', secret_env: 'HOOK_SECRET' }))).toBe(
      'Signed via HOOK_SECRET',
    );
    expect(getTriggerSubtitle(trigger({ type: 'webhook' }))).toBe('Unsigned');
  });
});

describe('describeRunAt', () => {
  test('does not throw on an invalid date', () => {
    expect(describeRunAt('not-a-date')).toBe('Runs once');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-03-04T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test('reports never when the trigger has not fired', () => {
    expect(relativeTime(null, now)).toBe('never');
  });

  test('buckets by minute, hour, and day', () => {
    expect(relativeTime(ago(30_000), now)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5m ago');
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe('2d ago');
  });

  test('falls back to an absolute date past 30 days', () => {
    expect(relativeTime(ago(40 * 86_400_000), now)).not.toContain('ago');
  });

  test('does not report a future timestamp as an elapsed duration', () => {
    expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe('just now');
  });
});

describe('normalizeSecretEnvName', () => {
  test('upper-snake-cases so a typed name cannot 400 on save', () => {
    expect(normalizeSecretEnvName('  my hook-secret ')).toBe('MY_HOOK_SECRET');
    expect(normalizeSecretEnvName('a.b/c')).toBe('A_B_C');
  });

  test('leaves an already-valid name untouched, and empty in means empty out', () => {
    expect(normalizeSecretEnvName('HOOK_SECRET_1')).toBe('HOOK_SECRET_1');
    expect(normalizeSecretEnvName('   ')).toBe('');
  });
});

describe('slugifyName', () => {
  test('slugifies ordinary names', () => {
    expect(slugifyName('Daily Standup Digest')).toBe('daily-standup-digest');
  });

  test('collapses runs and trims dashes', () => {
    expect(slugifyName('  --Weekly  ***  Report-- ')).toBe('weekly-report');
  });

  test('never returns empty', () => {
    expect(slugifyName('***')).toBe('trigger');
    expect(slugifyName('')).toBe('trigger');
  });

  test('caps length at 128', () => {
    expect(slugifyName('a'.repeat(300))).toHaveLength(128);
  });
});

describe('filter rows', () => {
  test('round-trips a filter through rows', () => {
    const filter = { 'body.event': 'deploy.succeeded', 'body.ref': 'main' };
    expect(rowsToFilter(filterToRows(filter))).toEqual(filter);
  });

  test('treats an absent filter as no rows and no filter', () => {
    expect(filterToRows(null)).toEqual([]);
    expect(filterToRows(undefined)).toEqual([]);
    expect(rowsToFilter([])).toBeNull();
  });

  test('drops blank paths and trims, so a half-typed row cannot be persisted', () => {
    expect(rowsToFilter([{ path: '  ', value: 'x' }])).toBeNull();
    expect(rowsToFilter([{ path: ' body.ref ', value: ' main ' }])).toEqual({
      'body.ref': 'main',
    });
  });
});

describe('sameFilter', () => {
  test('treats null and empty as equivalent', () => {
    expect(sameFilter(null, undefined)).toBe(true);
    expect(sameFilter(null, {})).toBe(true);
  });

  test('compares by key and value', () => {
    expect(sameFilter({ a: '1' }, { a: '1' })).toBe(true);
    expect(sameFilter({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameFilter({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(sameFilter({ a: '1', b: '2' }, { a: '1' })).toBe(false);
  });
});

describe('describeSessionStrategy', () => {
  test('renders the plain-language mode label', () => {
    expect(describeSessionStrategy(trigger({ session_mode: 'fresh' }))).toBe(
      'New session each run',
    );
  });

  test('appends a short session id when pinned', () => {
    const t = trigger({ session_mode: 'pinned', session_id: 'abcdef1234567890' });
    expect(describeSessionStrategy(t)).toBe('Pin a specific session… · abcdef12');
  });

  test('appends the key when keyed, and omits it when unset', () => {
    expect(
      describeSessionStrategy(trigger({ session_mode: 'keyed', session_key: '{{ body.id }}' })),
    ).toBe('One session per conversation · {{ body.id }}');
    expect(describeSessionStrategy(trigger({ session_mode: 'keyed' }))).toBe(
      'One session per conversation',
    );
  });
});

describe('generateSecret', () => {
  test('returns 64 hex chars and does not repeat', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(generateSecret());
  });
});

describe('buildCurlExample', () => {
  test('embeds the url and keeps the signature header', () => {
    const out = buildCurlExample('https://api.example.com/webhooks/abc');
    expect(out).toContain('curl -X POST https://api.example.com/webhooks/abc');
    expect(out).toContain('X-Kortix-Signature: sha256=');
  });
});
