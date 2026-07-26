/**
 * The decision procedure behind spec §4.2, tested directly.
 *
 * This is where a wrong answer is SILENT: a metric that forks into two series, a
 * flat run that never accumulates, or a threshold that reads as on-track all look
 * exactly like a healthy goal from every other surface. Nothing here touches a
 * database or a clock, so every branch is reachable from a literal.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FLAT_STALL_OBSERVATIONS,
  FLAT_STALL_ENV_KEY,
  moved,
  namesThreshold,
  normalizeMetric,
  normalizeObservationValue,
  resolveFlatStallThreshold,
  resolveGoalMeasurability,
  rollupGoalMetrics,
  serializeGoalMetric,
  summarizeMetric,
  type ObservationPoint,
} from './wire';

const AT = (minutes: number) => new Date(Date.UTC(2026, 6, 26, 9, minutes, 0));

/** Newest first, the order the store hands back. */
function points(...values: number[]): ObservationPoint[] {
  return values.map((value, index) => ({
    value,
    observedAt: AT(60 - index),
    source: 'session:s1',
  }));
}

describe('normalizeMetric', () => {
  test('folds case and whitespace so one metric is one series', () => {
    // The failure this prevents: `Google Rank` and `google_rank` as two series
    // that each look healthy while neither has moved — a forked series can never
    // accumulate a flat run, so the goal never stalls.
    expect(normalizeMetric('Google Rank')).toEqual({ metric: 'google_rank' });
    expect(normalizeMetric('  RANK  ')).toEqual({ metric: 'rank' });
    expect(normalizeMetric('core   terms rank')).toEqual({ metric: 'core_terms_rank' });
  });

  test('accepts the dot/dash/underscore vocabulary the CHECK constraint allows', () => {
    for (const name of ['rank', 'mrr_usd', 'google.rank', 'p95-latency', 'a1']) {
      expect(normalizeMetric(name)).toEqual({ metric: name });
    }
  });

  test('rejects rather than mangles anything else', () => {
    // Silently dropping the slash would produce a name the author did not choose
    // and cannot find again.
    for (const bad of ['impressions/day', '-leading-dash', '_leading', 'ünïcode', '']) {
      expect(normalizeMetric(bad)).toHaveProperty('error');
    }
    expect(normalizeMetric('x'.repeat(65))).toHaveProperty('error');
    expect(normalizeMetric('x'.repeat(64))).toEqual({ metric: 'x'.repeat(64) });
    expect(normalizeMetric(9)).toEqual({ error: 'metric is required' });
  });
});

describe('normalizeObservationValue', () => {
  test('takes finite numbers only', () => {
    expect(normalizeObservationValue(0)).toEqual({ value: 0 });
    expect(normalizeObservationValue(-3.5)).toEqual({ value: -3.5 });
  });

  test('refuses NaN and the infinities — Postgres sorts NaN above every real number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(normalizeObservationValue(bad)).toHaveProperty('error');
    }
  });

  test('refuses numeric-looking strings rather than coercing them', () => {
    // Number('') is 0 and Number('1e999') is Infinity: coercion would record a
    // reading that was never taken.
    for (const bad of ['9', '', '1e999', null, undefined, {}]) {
      expect(normalizeObservationValue(bad)).toEqual({ error: 'value must be a finite number' });
    }
  });
});

describe('moved', () => {
  test('float noise is not movement', () => {
    expect(moved(10000, 10000.0000000001)).toBe(false);
    expect(moved(0.1 + 0.2, 0.3)).toBe(false);
  });

  test('a genuine change of any size is', () => {
    expect(moved(9, 10)).toBe(true);
    expect(moved(0, 0.001)).toBe(true);
    // Relative tolerance stays meaningful at both ends of the scale.
    expect(moved(1e7, 1e7 + 1)).toBe(true);
  });
});

describe('summarizeMetric', () => {
  const window = 50;

  test('no readings is null, not an empty summary', () => {
    expect(summarizeMetric('rank', [], window)).toBeNull();
  });

  test('one reading is measured but has direction "unknown", never "flat"', () => {
    // Collapsing the two would start a brand-new metric down the road to a stall
    // it has not earned.
    const summary = summarizeMetric('rank', points(9), window)!;
    expect(summary.direction).toBe('unknown');
    expect(summary.previous).toBeNull();
    expect(summary.flatObservations).toBe(0);
  });

  test('direction compares the latest reading to the one before it', () => {
    expect(summarizeMetric('rank', points(9, 12), window)!.direction).toBe('down');
    expect(summarizeMetric('rank', points(12, 9), window)!.direction).toBe('up');
    expect(summarizeMetric('rank', points(9, 9), window)!.direction).toBe('flat');
  });

  test('the flat run counts consecutive re-measurements with no movement (R-12e)', () => {
    expect(summarizeMetric('rank', points(9, 9, 9, 9), window)!.flatObservations).toBe(3);
    expect(summarizeMetric('rank', points(9, 9, 12, 9), window)!.flatObservations).toBe(1);
    // A metric that just moved has no flat run at all, however long it sat before.
    expect(summarizeMetric('rank', points(8, 9, 9, 9), window)!.flatObservations).toBe(0);
  });

  test('the run is walked from the PRESENT — an escaped flat patch does not count', () => {
    expect(summarizeMetric('rank', points(5, 4, 9, 9, 9, 9), window)!.flatObservations).toBe(0);
  });

  test('the series comes back oldest → newest, which is the reading order', () => {
    const summary = summarizeMetric('rank', points(9, 10, 12), window)!;
    expect(summary.series.map((p) => p.value)).toEqual([12, 10, 9]);
    expect(summary.latest.value).toBe(9);
  });

  test('a full window is reported as truncated so nobody reads it as the whole history', () => {
    expect(summarizeMetric('rank', points(1, 2, 3), 3)!.windowTruncated).toBe(true);
    expect(summarizeMetric('rank', points(1, 2, 3), 4)!.windowTruncated).toBe(false);
  });
});

describe('rollupGoalMetrics', () => {
  test('groups by goal and orders metrics by name so the display never shuffles', () => {
    const rolled = rollupGoalMetrics(
      [
        { goalSlug: 'seo', metric: 'rank', points: points(9, 12) },
        { goalSlug: 'seo', metric: 'impressions', points: points(400) },
        { goalSlug: 'oil', metric: 'pnl', points: points(1) },
      ],
      50,
    );
    expect(rolled.get('seo')!.map((m) => m.metric)).toEqual(['impressions', 'rank']);
    expect(rolled.get('oil')!.map((m) => m.metric)).toEqual(['pnl']);
    expect(rolled.get('nothing')).toBeUndefined();
  });

  test('a metric with no points contributes nothing rather than an empty row', () => {
    expect(rollupGoalMetrics([{ goalSlug: 'seo', metric: 'rank', points: [] }], 50).size).toBe(0);
  });
});

describe('namesThreshold (R-12d)', () => {
  test('any digit counts', () => {
    expect(namesThreshold('Top 3 for the core terms, sustained 30 days.')).toBe(true);
    expect(namesThreshold('A live account runs unattended for 7 days.')).toBe(true);
  });

  test('a comparison word with no digit counts too', () => {
    expect(namesThreshold('A positive risk-adjusted return, sustained.')).toBe(true);
    expect(namesThreshold('Ranked above every competitor.')).toBe(true);
    expect(namesThreshold('Zero manual intervention.')).toBe(true);
  });

  test('word boundaries: "laptop" is not "top"', () => {
    expect(namesThreshold('The laptop fleet is imaged.')).toBe(false);
    expect(namesThreshold('An offer is signed and a start date is on the calendar.')).toBe(false);
  });
});

describe('resolveGoalMeasurability (R-12d)', () => {
  test('any observation makes the goal measured, whatever the prose says', () => {
    expect(resolveGoalMeasurability({ doneWhen: 'Be #1 on Google.', hasObservations: true })).toBe(
      'measured',
    );
  });

  test('a threshold with zero readings is UNMEASURABLE, never on-track', () => {
    // This is the entire ballgame for a goal like "be #1 on Google": nothing had
    // ever been recorded, and every surface reported it as an active goal with
    // open tasks — indistinguishable from one that was working.
    expect(resolveGoalMeasurability({ doneWhen: 'Be #1 on Google.', hasObservations: false })).toBe(
      'unmeasurable',
    );
  });

  test('prose with no threshold is UNQUANTIFIED — legal under R-7, and a different problem', () => {
    expect(
      resolveGoalMeasurability({
        doneWhen: 'An offer is signed and a start date is on the calendar.',
        hasObservations: false,
      }),
    ).toBe('unquantified');
  });
});

describe('resolveFlatStallThreshold', () => {
  test('defaults to three consecutive flat readings', () => {
    expect(resolveFlatStallThreshold({})).toBe(DEFAULT_FLAT_STALL_OBSERVATIONS);
    expect(DEFAULT_FLAT_STALL_OBSERVATIONS).toBe(3);
  });

  test('an env override is honoured', () => {
    expect(resolveFlatStallThreshold({ [FLAT_STALL_ENV_KEY]: '5' })).toBe(5);
    expect(resolveFlatStallThreshold({ [FLAT_STALL_ENV_KEY]: ' 1 ' })).toBe(1);
  });

  test('a bad override falls back rather than switching the detector off', () => {
    // `n >= NaN` is always false, so a typo would silently stop every stall from
    // ever being reported.
    for (const bad of ['', 'three', '-1', '0', '1.5']) {
      expect(resolveFlatStallThreshold({ [FLAT_STALL_ENV_KEY]: bad })).toBe(
        DEFAULT_FLAT_STALL_OBSERVATIONS,
      );
    }
  });
});

describe('serializeGoalMetric', () => {
  test('is the snake_case wire shape, with previous nullable', () => {
    const summary = summarizeMetric('rank', points(9, 12), 50)!;
    expect(serializeGoalMetric(summary)).toEqual({
      metric: 'rank',
      latest: { value: 9, observed_at: AT(60).toISOString(), source: 'session:s1' },
      previous: { value: 12, observed_at: AT(59).toISOString(), source: 'session:s1' },
      direction: 'down',
      flat_observations: 0,
      window_truncated: false,
    });
    expect(serializeGoalMetric(summarizeMetric('rank', points(9), 50)!).previous).toBeNull();
  });
});
