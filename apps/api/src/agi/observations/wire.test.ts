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
  type GoalMetricSummary,
  type ObservationPoint,
  moved,
  namesThreshold,
  normalizeMetric,
  normalizeObservationValue,
  resolveFlatStallThreshold,
  resolveGoalMeasurability,
  resolveGoalStall,
  rollupGoalMetrics,
  serializeGoalMetric,
  summarizeMetric,
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

  // R-12d says "without any observation ever being recorded FOR THAT METRIC".
  // `hasObservations` alone cannot see that: it is true the moment ANY series
  // exists, so a goal recording three unrelated numbers and never the one it
  // declares reads `measured` while nobody is measuring the thing it is about.
  test('a declared primary that was never observed is UNMEASURABLE even with other series', () => {
    expect(
      resolveGoalMeasurability({
        doneWhen: 'Top 3 for the core terms.',
        hasObservations: true,
        primaryUnobserved: true,
      }),
    ).toBe('unmeasurable');
  });

  test('an observed primary leaves the ordinary answer alone', () => {
    expect(
      resolveGoalMeasurability({
        doneWhen: 'Top 3 for the core terms.',
        hasObservations: true,
        primaryUnobserved: false,
      }),
    ).toBe('measured');
  });
});

describe('resolveGoalStall (R-12e)', () => {
  /** Newest first, the order the store hands back. */
  function series(metric: string, ...values: number[]): GoalMetricSummary {
    return summarizeMetric(metric, points(...values), 50)!;
  }

  const stall = (metrics: GoalMetricSummary[], primaryMetric: string | null = null) =>
    resolveGoalStall({ metrics, primaryMetric, flatStallAfter: 3 });

  // The exact live failure. Three metrics off a real platinum.dev manifest: the
  // position that `done_when` is literally about sat at 9.4 for 20 consecutive
  // readings across 21 days while impressions and clicks wandered. Under the old
  // "EVERY metric must be flat" rule this was `measuring` with
  // stalled_goal_count 0 — rank did not move for three weeks and nothing noticed.
  const PLATINUM = () => [
    series('gsc_avg_position_core', ...Array(21).fill(9.4)),
    series('impressions', 5100, 4800, 5300, 4950),
    series('clicks', 61, 44, 70, 52),
  ];

  test('one noisy metric can no longer hide the flat one', () => {
    const verdict = stall(PLATINUM());
    expect(verdict.stalled).toBe(true);
    expect(verdict.rule).toBe('any_metric');
    expect(verdict.drivenBy).toBe('gsc_avg_position_core');
  });

  test('a declared primary IS the verdict, whatever the others do', () => {
    const verdict = stall(PLATINUM(), 'gsc_avg_position_core');
    expect(verdict.stalled).toBe(true);
    expect(verdict.rule).toBe('primary');
    expect(verdict.drivenBy).toBe('gsc_avg_position_core');
    expect(verdict.primaryMetric).toBe('gsc_avg_position_core');
    expect(verdict.primaryUnobserved).toBe(false);
  });

  test('a flat SECONDARY cannot condemn a declared goal, and stays visible anyway', () => {
    const verdict = stall(
      [series('gsc_avg_position_core', 7.2, 8.1, 9.4), series('clicks', 61, 61, 61, 61)],
      'gsc_avg_position_core',
    );
    expect(verdict.stalled).toBe(false);
    expect(verdict.drivenBy).toBeNull();
    // Reported, but not the verdict — the whole reason `rule` is on the result.
    expect(verdict.flatMetrics).toEqual([{ metric: 'clicks', flatObservations: 3 }]);
  });

  test('a declared primary nobody ever recorded is unobserved, never stalled', () => {
    // Not `stalled`: there is no run to be flat. The caller turns this into
    // `unmeasurable` (R-12d), which is a different fix — start measuring, rather
    // than work harder.
    const verdict = stall([series('impressions', 5100, 4800)], 'gsc_avg_position_core');
    expect(verdict.primaryUnobserved).toBe(true);
    expect(verdict.stalled).toBe(false);
    expect(verdict.drivenBy).toBeNull();
    expect(verdict.primaryMetric).toBe('gsc_avg_position_core');
  });

  test('the primary is matched exactly — a near-miss name is an unobserved primary', () => {
    // Both sides go through normalizeMetric, so `===` is the whole comparison.
    // A looser match would let a declaration read as honoured while pointing at
    // a series that does not exist.
    const verdict = stall(
      [series('gsc_avg_position', 9.4, 9.4, 9.4, 9.4)],
      'gsc_avg_position_core',
    );
    expect(verdict.primaryUnobserved).toBe(true);
  });

  test('under the any-metric rule the LONGEST flat run is the named driver', () => {
    const verdict = stall([series('rank', 9, 9, 9, 9), series('signups', 40, 40, 40, 40, 40, 40)]);
    expect(verdict.drivenBy).toBe('signups');
    expect(verdict.flatMetrics.map((m) => m.metric)).toEqual(['signups', 'rank']);
  });

  test('nothing flat past the threshold is no stall under either rule', () => {
    expect(stall([series('rank', 9, 9, 9)]).stalled).toBe(false);
    expect(stall([series('rank', 9, 9, 9)], 'rank').stalled).toBe(false);
    expect(stall([]).stalled).toBe(false);
    expect(stall([]).rule).toBe('any_metric');
  });

  test('a goal with no metrics and no declaration has no primary to miss', () => {
    expect(stall([]).primaryUnobserved).toBe(false);
    expect(stall([]).primaryMetric).toBeNull();
  });

  test('an empty-string declaration is no declaration — never a phantom primary', () => {
    // A manifest that writes `metric: ""` must fall back to the conservative
    // rule, not report an unobservable primary the author cannot see.
    expect(resolveGoalStall({ metrics: [], primaryMetric: '', flatStallAfter: 3 }).rule).toBe(
      'any_metric',
    );
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
