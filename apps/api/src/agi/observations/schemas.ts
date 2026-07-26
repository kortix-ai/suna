/**
 * OpenAPI shapes for the AGI observation surface. Documentation only — the
 * handlers own validation, exactly as the task and goal routes do, so the
 * specific messages (`value must be a finite number`) survive instead of being
 * flattened into the shared zod-failure envelope.
 */
import { GOAL_MEASURABILITIES, METRIC_DIRECTIONS } from './wire';
import { z } from '@hono/zod-openapi';

export const AgiObservationPointSchema = z
  .object({
    value: z.number(),
    observed_at: z.string(),
    source: z.string(),
  })
  .openapi('AgiObservationPoint');

export const AgiObservationSchema = z
  .object({
    observation_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    goal_slug: z.string(),
    metric: z.string(),
    value: z.number(),
    observed_at: z.string(),
    source: z.string(),
    created_at: z.string(),
  })
  .openapi('AgiObservation');

export const AgiGoalMetricSchema = z
  .object({
    metric: z.string(),
    latest: AgiObservationPointSchema,
    /** Null when only one reading exists — which is why `direction` is
     *  `unknown` there rather than `flat`. */
    previous: AgiObservationPointSchema.nullable(),
    direction: z.enum(METRIC_DIRECTIONS),
    /** R-12e: consecutive re-measurements with no movement. */
    flat_observations: z.number(),
    window_truncated: z.boolean(),
  })
  .openapi('AgiGoalMetric');

export const AgiGoalMetricSeriesSchema = AgiGoalMetricSchema.extend({
  /** Oldest → newest, bounded by the load window. */
  series: z.array(AgiObservationPointSchema),
}).openapi('AgiGoalMetricSeries');

export const AgiGoalMeasurabilitySchema = z
  .enum(GOAL_MEASURABILITIES)
  .openapi('AgiGoalMeasurability');

export const AgiObserveBodySchema = z.record(z.string(), z.any()).openapi('AgiObserveBody');

export const AgiObserveResultSchema = z
  .object({ observation: AgiObservationSchema })
  .openapi('AgiObserveResult');

export const AgiObservationListSchema = z
  .object({
    observations: z.array(AgiObservationSchema),
    truncated: z.boolean(),
  })
  .openapi('AgiObservationList');
