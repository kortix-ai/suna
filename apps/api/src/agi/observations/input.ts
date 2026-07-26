/**
 * Request parsing for the AGI observation routes.
 *
 * Pure and synchronous, the same contract tasks/input.ts sets: everything
 * decidable without the database is decided here, so a CHECK violation (23514)
 * from `agi_observations_value_finite_check` or the metric-shape constraint can
 * never be the error a client sees.
 */
import type { Parsed } from '../tasks/input';
import { normalizeMetric, normalizeObservationValue } from './wire';

export const OBSERVATION_SOURCE_MAX_LENGTH = 255;

/** How far ahead of the server clock a caller-supplied `observed_at` may sit.
 *  Some skew is normal when a webhook relays a reading from another machine; a
 *  reading dated next month would pin `latest` until that date actually arrives,
 *  which would freeze the goal's direction of travel indefinitely. */
export const OBSERVED_AT_MAX_SKEW_MS = 24 * 60 * 60 * 1000;

export interface ObserveFields {
  metric: string;
  value: number;
  /** Null means "the route decides" — see the source-derivation note there. */
  source: string | null;
  observedAt: Date | null;
}

export function parseObserveBody(body: Record<string, unknown>): Parsed<ObserveFields> {
  const metric = normalizeMetric(body.metric);
  if ('error' in metric) return { ok: false, error: { error: metric.error } };

  const value = normalizeObservationValue(body.value);
  if ('error' in value) return { ok: false, error: { error: value.error } };

  let source: string | null = null;
  if (body.source !== undefined && body.source !== null) {
    if (typeof body.source !== 'string') return { ok: false, error: { error: 'Invalid source' } };
    const trimmed = body.source.trim();
    if (trimmed.length === 0 || trimmed.length > OBSERVATION_SOURCE_MAX_LENGTH) {
      return {
        ok: false,
        error: {
          error: `source must be 1-${OBSERVATION_SOURCE_MAX_LENGTH} characters`,
        },
      };
    }
    source = trimmed;
  }

  let observedAt: Date | null = null;
  if (body.observed_at !== undefined && body.observed_at !== null) {
    if (typeof body.observed_at !== 'string') {
      return { ok: false, error: { error: 'observed_at must be an ISO-8601 timestamp' } };
    }
    const parsed = Date.parse(body.observed_at);
    if (Number.isNaN(parsed)) {
      return { ok: false, error: { error: 'observed_at must be an ISO-8601 timestamp' } };
    }
    if (parsed > Date.now() + OBSERVED_AT_MAX_SKEW_MS) {
      return { ok: false, error: { error: 'observed_at is too far in the future' } };
    }
    observedAt = new Date(parsed);
  }

  return { ok: true, value: { metric: metric.metric, value: value.value, source, observedAt } };
}

export interface ObservationRangeQuery {
  metric?: string;
  since?: Date;
  until?: Date;
}

/**
 * `?metric=&since=&until=` for the series read.
 *
 * The metric goes through the SAME normalizer the write path uses — otherwise
 * `?metric=Google%20Rank` would return an empty series for a metric that is
 * plainly there, which reads as "never measured" and is the one wrong answer
 * this surface must not give.
 */
export function parseObservationRangeQuery(query: {
  metric?: string;
  since?: string;
  until?: string;
}): Parsed<ObservationRangeQuery> {
  const parsed: ObservationRangeQuery = {};

  if (query.metric !== undefined && query.metric !== '') {
    const metric = normalizeMetric(query.metric);
    if ('error' in metric) return { ok: false, error: { error: 'Invalid metric' } };
    parsed.metric = metric.metric;
  }

  for (const [key, raw] of [
    ['since', query.since],
    ['until', query.until],
  ] as const) {
    if (raw === undefined || raw === '') continue;
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return { ok: false, error: { error: `Invalid ${key}` } };
    parsed[key] = new Date(at);
  }

  if (parsed.since && parsed.until && parsed.since.getTime() > parsed.until.getTime()) {
    return { ok: false, error: { error: 'since must not be after until' } };
  }
  return { ok: true, value: parsed };
}
