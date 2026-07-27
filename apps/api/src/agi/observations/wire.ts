/**
 * AGI observations — the pure half of spec §4.2 (R-12a … R-12f).
 *
 * Everything here is a total function over already-fetched rows. No database, no
 * Hono context, no clock of its own. That is the same discipline liveness/wire.ts
 * follows and for the same reason: this is the code that decides whether a goal
 * got closer, and a wrong answer here is silent — the loop keeps looking alive
 * while the number has not moved for three weeks.
 *
 * Five things are decided here and nowhere else:
 *
 *   • {@link normalizeMetric} — one metric name, one series. A metric written
 *     two ways is two series that each look healthy while neither has moved.
 *   • {@link summarizeMetric} — latest, previous, direction, and the flat run
 *     that R-12e turns into a stall.
 *   • {@link namesThreshold} / {@link resolveGoalMeasurability} — R-12d's
 *     distinction between "on track" and "nobody has ever measured this".
 *   • {@link resolveFlatStallThreshold} — how many flat readings is a stall.
 *   • {@link resolveGoalStall} — WHICH metric's flat line condemns the goal.
 *     The verdict itself lives in ../liveness/wire.ts, but the rule lives here,
 *     with the series it reasons about and the only test file that can load it.
 *
 * What is deliberately NOT here: anything that declares a probe. R-12a makes a
 * signal a trigger. A measurement arrives from an ordinary cron trigger's session
 * or an ordinary webhook's session; this module never schedules, polls, or
 * registers anything.
 */
import type { agiObservations } from '@kortix/db';

export type AgiObservationRow = typeof agiObservations.$inferSelect;

// ─── metric names ───────────────────────────────────────────────────────────

export const METRIC_MAX_LENGTH = 64;

/** Mirrors `agi_observations_metric_check`. The database constraint is the
 *  backstop; this is where a caller gets a message they can act on. */
const METRIC_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One canonical spelling per metric.
 *
 * Case and internal whitespace are folded rather than rejected because the
 * producers are agents writing a CLI flag: `--metric "Google Rank"` and
 * `--metric google_rank` mean the same series, and letting them fork is the
 * exact failure R-12e exists to catch — two half-length series never accumulate
 * a flat run, so the goal looks measured and never stalls.
 *
 * Everything else is rejected rather than mangled. Silently dropping a `/` from
 * `impressions/day` would produce a name the author did not choose and cannot
 * find again.
 */
export function normalizeMetric(raw: unknown): { metric: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'metric is required' };
  const metric = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (metric.length === 0) return { error: 'metric is required' };
  if (!METRIC_RE.test(metric)) {
    return {
      error: `metric must be 1-${METRIC_MAX_LENGTH} characters of a-z, 0-9, dot, dash, or underscore, starting with a letter or digit (got "${raw}")`,
    };
  }
  return { metric };
}

// ─── values ─────────────────────────────────────────────────────────────────

/**
 * A real number, and nothing that merely looks like one.
 *
 * Strings are refused rather than coerced: `Number('')` is 0 and `Number('1e999')`
 * is Infinity, so accepting them would let a producer record a reading it never
 * took. NaN and the infinities are refused for the reason the CHECK constraint
 * spells out — Postgres sorts NaN above every real number, so one of them would
 * pin `latest` forever.
 */
export function normalizeObservationValue(raw: unknown): { value: number } | { error: string } {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { error: 'value must be a finite number' };
  }
  return { value: raw };
}

/**
 * Did the metric move between two readings?
 *
 * Compared with a relative tolerance rather than `===` because the values are
 * IEEE-754 doubles: a revenue figure that arrives as 10000 one day and
 * 10000.0000000001 the next has not moved, and treating that as movement would
 * make a flat line un-detectable — which is precisely the thing R-12e is for.
 * The tolerance is relative so it stays meaningful for both a search rank (1) and
 * an ARR figure (10^7).
 */
export const MOVEMENT_EPSILON = 1e-9;

export function moved(a: number, b: number): boolean {
  return Math.abs(a - b) > MOVEMENT_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

// ─── the series ─────────────────────────────────────────────────────────────

export interface ObservationPoint {
  value: number;
  observedAt: Date;
  source: string;
}

/**
 * Which way the metric is travelling.
 *
 * `unknown` is NOT `flat`. One reading proves the goal is measured and proves
 * nothing about movement; collapsing the two would report a brand-new metric as
 * flat and start it down the road to a stall it has not earned.
 */
export const METRIC_DIRECTIONS = ['up', 'down', 'flat', 'unknown'] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export interface GoalMetricSummary {
  metric: string;
  latest: ObservationPoint;
  /** The reading before `latest`, or null when this is the first one. */
  previous: ObservationPoint | null;
  direction: MetricDirection;
  /**
   * R-12e's counter: how many consecutive re-measurements produced no movement.
   *
   * Named for what it counts. The spec says "N consecutive pushes"; a push that
   * takes a reading writes exactly one observation (R-12a — the trigger session
   * IS the producer), and a push that takes NO reading cannot testify either way
   * about whether the metric moved. So the honest unit is the reading, not the
   * fire, and it needs no second bookkeeping table to stay true.
   *
   * 0 for a metric with one reading, or one that just moved.
   */
  flatObservations: number;
  /** Oldest → newest, bounded by the load window. The reading order for a human
   *  and for `kortix goals show`. */
  series: ObservationPoint[];
  /** True when older readings exist beyond the window — so a caller never reads
   *  a truncated series as the whole history. */
  windowTruncated: boolean;
}

/**
 * Summarize one metric from its readings, NEWEST FIRST.
 *
 * Newest-first is the order the index produces and the order the flat run has to
 * be walked in: the run that matters is the one ending at the present, and
 * walking from the oldest end would count a flat patch the metric has since
 * escaped.
 */
export function summarizeMetric(
  metric: string,
  newestFirst: readonly ObservationPoint[],
  windowSize: number,
): GoalMetricSummary | null {
  if (newestFirst.length === 0) return null;

  const latest = newestFirst[0];
  const previous = newestFirst[1] ?? null;

  let direction: MetricDirection = 'unknown';
  if (previous) {
    direction = !moved(latest.value, previous.value)
      ? 'flat'
      : latest.value > previous.value
        ? 'up'
        : 'down';
  }

  let flatObservations = 0;
  for (let i = 1; i < newestFirst.length; i += 1) {
    if (moved(latest.value, newestFirst[i].value)) break;
    flatObservations += 1;
  }

  return {
    metric,
    latest,
    previous,
    direction,
    flatObservations,
    series: [...newestFirst].reverse(),
    // A full window means the loader hit its cap, so there may be more behind it.
    windowTruncated: newestFirst.length >= windowSize,
  };
}

/** One metric's loaded readings, newest first — what the store hands back and
 *  what {@link summarizeMetric} consumes. */
export interface MetricWindow {
  goalSlug: string;
  metric: string;
  points: ObservationPoint[];
}

/**
 * Windows → per-goal summaries, keyed by goal slug.
 *
 * Metrics come back sorted by name rather than by recency or magnitude: a goal's
 * metric list is read by a human on every `goals show`, and an ordering that
 * shuffles when a number changes is unreadable.
 */
export function rollupGoalMetrics(
  windows: readonly MetricWindow[],
  windowSize: number,
): Map<string, GoalMetricSummary[]> {
  const byGoal = new Map<string, GoalMetricSummary[]>();
  for (const window of windows) {
    const summary = summarizeMetric(window.metric, window.points, windowSize);
    if (!summary) continue;
    const bucket = byGoal.get(window.goalSlug);
    if (bucket) bucket.push(summary);
    else byGoal.set(window.goalSlug, [summary]);
  }
  for (const summaries of byGoal.values()) {
    summaries.sort((a, b) => a.metric.localeCompare(b.metric));
  }
  return byGoal;
}

// ─── R-12d: measurable, unmeasurable, unquantified ──────────────────────────

/**
 * Where a goal stands on being judgeable at all.
 *
 *   measured      — at least one reading exists, so `done_when` has a series to
 *                   be evaluated against.
 *   unmeasurable  — `done_when` names a threshold and NOTHING has ever been
 *                   recorded — or the goal DECLARES the metric that defines it
 *                   and that metric has never been recorded, whatever else has.
 *                   R-12d: this must never read as on-track. It is the
 *                   distinction the whole section exists for — a goal like
 *                   "be #1 on Google" with no observations is not progressing
 *                   slowly, it is un-judged. R-12d says "without any observation
 *                   ever being recorded FOR THAT METRIC", so a goal recording
 *                   three unrelated series and never the declared one is exactly
 *                   as un-judged as a goal recording nothing at all.
 *   unquantified  — `done_when` names no threshold and nothing is recorded. Legal
 *                   (R-7 only requires prose), and a different problem from
 *                   `unmeasurable`: nothing here is broken, there is just nothing
 *                   to plot.
 */
export const GOAL_MEASURABILITIES = ['measured', 'unmeasurable', 'unquantified'] as const;
export type GoalMeasurability = (typeof GOAL_MEASURABILITIES)[number];

/**
 * Phrases that turn prose into a quantified or HELD condition. Word-bounded so
 * `top` does not match `laptop`.
 */
const THRESHOLD_PHRASE_RE =
  /\b(at least|at most|no more than|no fewer than|no less than|more than|less than|fewer than|greater than|under|below|above|over|exceeds?|sustained|consecutive|streak|percent|minimum|maximum|top|rank(?:ed|ing)?|zero|positive|negative|majority|doubled?|tripled?|half)\b/i;

/**
 * Does this `done_when` name something a number could settle?
 *
 * Deliberately GENEROUS — any digit counts, and so does a comparison word with no
 * digit at all ("sustained", "positive risk-adjusted return"). The bias is chosen,
 * not accidental: over-reporting `unmeasurable` costs a human one glance at a
 * goal they should be measuring anyway, while under-reporting hides exactly the
 * failure mode §4.2 was written to stop. Same direction the liveness module takes
 * when it prefers a surfaced stall to a missed one.
 */
export function namesThreshold(doneWhen: string): boolean {
  return /\d/.test(doneWhen) || THRESHOLD_PHRASE_RE.test(doneWhen);
}

export function resolveGoalMeasurability(input: {
  doneWhen: string;
  hasObservations: boolean;
  /**
   * True when the goal DECLARES a primary metric (`metric:` in kortix.yaml) and
   * that metric has never been observed. Checked FIRST and unconditionally:
   * `hasObservations` is true the moment any series exists, so without this a
   * goal that declares `gsc_avg_position_core` and only ever records
   * `impressions` reads `measured` while the number that defines it has never
   * been taken once. That is the same "one noisy metric hides the flat one"
   * failure R-12e is about, one step earlier — before there is even a reading to
   * be flat.
   */
  primaryUnobserved?: boolean;
}): GoalMeasurability {
  if (input.primaryUnobserved) return 'unmeasurable';
  if (input.hasObservations) return 'measured';
  return namesThreshold(input.doneWhen) ? 'unmeasurable' : 'unquantified';
}

// ─── R-12e: how many flat readings is a stall ───────────────────────────────

/**
 * Three.
 *
 * With the documented daily `push`, three consecutive identical readings is 72
 * hours of a metric not moving: long enough that it is a pattern rather than a
 * quiet Tuesday, short enough that a human still has the week to act on it. Two
 * would fire on any metric that reports weekly; five would let a goal sit dead
 * for most of a sprint before anyone is told.
 *
 * Open item in spec §13 — the number is expected to move, which is why it is one
 * constant with one env override rather than a value threaded through callers.
 */
export const DEFAULT_FLAT_STALL_OBSERVATIONS = 3;

export const FLAT_STALL_ENV_KEY = 'KORTIX_AGI_FLAT_STALL_OBSERVATIONS';

/** A bad value falls back to the default rather than throwing: a typo in an env
 *  var must not be able to switch the stall detector off, which is what a `NaN`
 *  threshold would silently do (`n >= NaN` is always false). */
export function resolveFlatStallThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[FLAT_STALL_ENV_KEY];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_FLAT_STALL_OBSERVATIONS;
  const value = Number(raw.trim());
  return value >= 1 ? value : DEFAULT_FLAT_STALL_OBSERVATIONS;
}

// ─── R-12e: WHICH metric's flat line condemns the goal ──────────────────────

/**
 * Which rule produced a stall verdict. Carried on the verdict rather than
 * inferred, because the two rules disagree on purpose and a reader who cannot
 * tell which one ran cannot tell whether "measuring" means "the metric that
 * matters moved" or "some metric moved".
 *
 *   primary     — the goal declares `metric:` in kortix.yaml. THAT series is the
 *                 verdict; every other metric is context.
 *   any_metric  — the goal declares none, so any metric flat past N stalls it.
 */
export const GOAL_STALL_RULES = ['primary', 'any_metric'] as const;
export type GoalStallRule = (typeof GOAL_STALL_RULES)[number];

export interface GoalStallVerdict {
  rule: GoalStallRule;
  /** Has this goal's defining series stopped moving? */
  stalled: boolean;
  /** The declared primary metric, or null under `any_metric`. */
  primaryMetric: string | null;
  /** R-12d, per-metric: a primary is declared and nothing has ever been recorded
   *  for it. Never `stalled` — there is no run to be flat — and never on-track. */
  primaryUnobserved: boolean;
  /** The metric whose flat run produced `stalled`, or null. Under `primary` this
   *  is always the primary; under `any_metric` it is the LONGEST flat run, which
   *  is the one a human should look at first. */
  drivenBy: string | null;
  /** Every metric at or past the threshold, worst run first — reported whether or
   *  not it drove the verdict, so a flat series is visible before it condemns
   *  anything and a flat non-primary is visible even though it never will. */
  flatMetrics: { metric: string; flatObservations: number }[];
}

/**
 * R-12e, decided from the series alone.
 *
 * This used to stall a goal only when EVERY metric was flat past N, on the
 * reasoning that "something moved, so the goal advanced". That reasoning is
 * wrong, and it failed live: a platinum.dev manifest recorded
 * `gsc_avg_position_core`, `impressions`, and `clicks`; the position — the number
 * `done_when` is literally about — sat at 9.4 for 20 consecutive readings across
 * 21 days while impressions and clicks wandered on their own. The goal reported
 * `measuring` with `stalled_goal_count: 0`. Rank did not move for three weeks and
 * nothing noticed, which is verbatim the failure §4.2 exists to prevent.
 *
 * The root cause is that `done_when` is prose and names no metric, so nothing
 * associated the threshold with a series. Both halves of the fix follow from
 * that:
 *
 *   1. A goal MAY declare the metric that defines it (`metric:` in kortix.yaml —
 *      authored state, so R-2 puts it in the manifest, not the database). When it
 *      does, that series alone is the verdict. Other metrics stay visible in
 *      `flatMetrics` but cannot vote.
 *
 *   2. When it does NOT, ANY metric flat past N stalls the goal. Deliberately the
 *      opposite of the old rule: over-reporting a stall costs a human one glance
 *      at a goal they should be looking at anyway, while under-reporting is three
 *      silent weeks. Same direction {@link namesThreshold} takes, and the same
 *      direction the liveness module takes for tasks.
 *
 * `rule` and `drivenBy` ride along so the answer is never ambiguous: "stalled
 * because `gsc_avg_position_core`, the declared primary, has not moved in 20
 * readings" and "stalled because `clicks` has not moved in 4" are different
 * statements and a human needs to be told which one they are reading.
 *
 * Total and pure — no clock, no database, no manifest read.
 */
export function resolveGoalStall(input: {
  metrics: readonly GoalMetricSummary[];
  /** Already normalized by the manifest parser, so it compares by `===` against
   *  a recorded metric name. Both sides go through {@link normalizeMetric}; a
   *  second, looser comparison here would let `Core Position` declare a primary
   *  that `core_position` never satisfies. */
  primaryMetric: string | null;
  flatStallAfter: number;
}): GoalStallVerdict {
  const flatMetrics = input.metrics
    .filter((metric) => metric.flatObservations >= input.flatStallAfter)
    .map((metric) => ({ metric: metric.metric, flatObservations: metric.flatObservations }))
    .sort((a, b) => b.flatObservations - a.flatObservations);

  const primaryMetric = input.primaryMetric || null;

  if (primaryMetric) {
    const summary = input.metrics.find((metric) => metric.metric === primaryMetric) ?? null;
    if (!summary) {
      // R-12d. The strongest signal the system can emit: the goal names the
      // number it is about and nobody has ever taken it. Reported as its own
      // state by the caller, never as `stalled` (no run to be flat) and never as
      // on-track.
      return {
        rule: 'primary',
        stalled: false,
        primaryMetric,
        primaryUnobserved: true,
        drivenBy: null,
        flatMetrics,
      };
    }
    const stalled = summary.flatObservations >= input.flatStallAfter;
    return {
      rule: 'primary',
      stalled,
      primaryMetric,
      primaryUnobserved: false,
      drivenBy: stalled ? primaryMetric : null,
      flatMetrics,
    };
  }

  const worst = flatMetrics[0] ?? null;
  return {
    rule: 'any_metric',
    stalled: worst !== null,
    primaryMetric: null,
    primaryUnobserved: false,
    drivenBy: worst?.metric ?? null,
    flatMetrics,
  };
}

// ─── serialization ──────────────────────────────────────────────────────────

export function serializeObservationPoint(point: ObservationPoint) {
  return {
    value: point.value,
    observed_at: point.observedAt.toISOString(),
    source: point.source,
  };
}

export function serializeAgiObservation(row: AgiObservationRow) {
  return {
    observation_id: row.observationId,
    workspace_id: row.workspaceId,
    goal_slug: row.goalSlug,
    metric: row.metric,
    value: row.value,
    observed_at: row.observedAt.toISOString(),
    source: row.source,
    created_at: row.createdAt.toISOString(),
  };
}

export type SerializedAgiObservation = ReturnType<typeof serializeAgiObservation>;

export function serializeGoalMetric(summary: GoalMetricSummary) {
  return {
    metric: summary.metric,
    latest: serializeObservationPoint(summary.latest),
    previous: summary.previous ? serializeObservationPoint(summary.previous) : null,
    direction: summary.direction,
    flat_observations: summary.flatObservations,
    window_truncated: summary.windowTruncated,
  };
}

/** The detail view adds the points themselves — the list view carries only the
 *  head of the series, because a list of goals must stay one screen. */
export function serializeGoalMetricWithSeries(summary: GoalMetricSummary) {
  return {
    ...serializeGoalMetric(summary),
    series: summary.series.map(serializeObservationPoint),
  };
}
