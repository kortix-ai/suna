/**
 * The AGI goal WIRE contract: goal → JSON, manifest issue → JSON, and the one
 * query-parameter parser the list route takes.
 *
 * Everything here is pure — no database, no git, no Hono context — because the
 * interesting edge cases (recovering an ordinal for a malformed entry) are worth
 * testing directly. The routes stay a thin shell: read, filter, serialize.
 *
 * Goals are AUTHORED state read out of `kortix.yaml` on every request; nothing
 * in this surface writes one. The only cloud-side facts folded in are the task
 * counts and the derived trigger's runtime row.
 */
import { GOAL_STATUSES, type GoalParseError, type GoalSpec, type GoalStatus } from '../../projects/lib/agi-goals';
import {
  resolveGoalMeasurability,
  serializeGoalMetric,
  serializeGoalMetricWithSeries,
  type GoalMetricSummary,
} from '../observations/wire';
import { TASK_STATUSES, TERMINAL_TASK_STATUSES } from '../tasks/wire';

/** Per-status task tallies for one goal, every status present so a caller never
 *  has to distinguish "zero" from "key absent". */
export type GoalTaskCounts = Record<string, number>;

export function emptyGoalTaskCounts(): GoalTaskCounts {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
}

export function openTaskCount(counts: GoalTaskCounts): number {
  return TASK_STATUSES.filter(
    (status) => !(TERMINAL_TASK_STATUSES as readonly string[]).includes(status),
  ).reduce((total, status) => total + (counts[status] ?? 0), 0);
}

/**
 * Goal spec + its cloud-side tallies → wire.
 *
 * `push`/`trigger_slug` are both nullable and move together: a goal with no
 * standing advance desugars to no trigger, which is why `goals push` on it is a
 * conflict rather than a fire.
 *
 * `metrics` and `measurability` are what make R-12's "measurably advanced"
 * checkable. Before them a goal's only evidence of progress was its open task
 * count, which moves whenever an agent invents work and says nothing about
 * whether the goal got closer. `measurability` is carried EXPLICITLY rather than
 * inferred from `metrics.length === 0`, because R-12d's whole point is that a
 * threshold nobody measures is a different state from a goal that has no
 * threshold to measure — and a bare empty array cannot tell them apart.
 */
export function serializeAgiGoal(
  goal: GoalSpec,
  counts: GoalTaskCounts,
  metrics: readonly GoalMetricSummary[] = [],
) {
  return {
    slug: goal.slug,
    title: goal.title,
    done_when: goal.doneWhen,
    status: goal.status,
    push: goal.push,
    agent: goal.agent,
    timezone: goal.timezone,
    path: goal.path,
    trigger_slug: goal.triggerSlug,
    task_counts: counts,
    open_task_count: openTaskCount(counts),
    metrics: metrics.map(serializeGoalMetric),
    measurability: resolveGoalMeasurability({
      doneWhen: goal.doneWhen,
      hasObservations: metrics.length > 0,
    }),
  };
}

export type SerializedAgiGoal = ReturnType<typeof serializeAgiGoal>;

/** The detail view's metrics: same summaries, plus the points themselves, so
 *  `kortix goals show` can render the series without a second round trip. */
export function serializeGoalMetricSeries(metrics: readonly GoalMetricSummary[]) {
  return metrics.map(serializeGoalMetricWithSeries);
}

/** A goal the manifest declares but the parser rejected. `index` is the entry's
 *  ordinal in the `goals:` list, or -1 for a problem with the block as a whole. */
export interface AgiGoalIssue {
  index: number;
  slug: string | null;
  message: string;
  path: string;
}

/** Placeholder slugs the goal parser emits when the entry has no usable slug of
 *  its own. They are diagnostics, not identities, so they go out as `slug: null`
 *  and the caller addresses the entry by its {@link AgiGoalIssue.index}. */
const SYNTHETIC_SLUG = /^\((invalid|top-level|manifest)\)$|^\(index-\d+\)$/;

/**
 * Parse errors → the wire shape, so a broken goal is addressable in the list
 * where it has no slug to be addressed by.
 *
 * The ordinal is read straight off {@link GoalParseError}: the parser iterates
 * with it and now carries it. This used to reconstruct it by matching each error
 * back against the raw `goals:` entries — exact for every case that came up, but
 * a reconstruction of a fact the producer already had.
 */
export function goalIssues(loaded: { errors: readonly GoalParseError[] }): AgiGoalIssue[] {
  return loaded.errors.map((error) => ({
    index: error.index,
    slug: SYNTHETIC_SLUG.test(error.slug) ? null : error.slug,
    message: error.error,
    path: error.path,
  }));
}

/** `?status=` — one goal status, or null for "invalid" which the route reports
 *  as 400. Absent means every status: there are single digits of goals (R-10),
 *  so the unfiltered list is the useful default. */
export function parseGoalStatusFilter(raw: string | undefined): GoalStatus | 'all' | null {
  if (raw === undefined || raw === '') return 'all';
  return (GOAL_STATUSES as readonly string[]).includes(raw) ? (raw as GoalStatus) : null;
}
