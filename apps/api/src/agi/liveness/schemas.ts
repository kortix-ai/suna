/**
 * OpenAPI shapes for the stall surface. Documentation only — the handlers own
 * validation, exactly as the task routes do, so the normative error strings
 * survive instead of being flattened into the shared zod-failure envelope.
 */
import { AgiGoalMetricSchema } from '../observations/schemas';
import { AgiTaskSchema } from '../tasks/schemas';
import { GOAL_LIVENESS_STATES, GOAL_STALL_REASONS, LIVENESS_STATES, STALL_REASONS } from './wire';
import { z } from '@hono/zod-openapi';

export const AgiTaskLivenessSchema = z
  .object({
    state: z.enum(LIVENESS_STATES),
    reason: z.enum(STALL_REASONS).nullable(),
    claim_session_state: z.enum(['active', 'terminal', 'unknown']).nullable(),
    unresolved_blockers: z.array(z.string().uuid()),
    recovery: z
      .object({
        task_id: z.string().uuid(),
        escalated: z.boolean(),
        escalated_to: z.string().uuid().nullable(),
      })
      .nullable(),
    /** R-12g / R-28 answer 5. Present whenever the task carries a pending human
     *  request, in EVERY state — `delivered: false` is the one that means the
     *  ask exists and nobody was told. */
    request: z
      .object({
        request_id: z.string().uuid(),
        kind: z.string(),
        need: z.string(),
        responder_user_id: z.string().uuid().nullable(),
        delivered: z.boolean(),
        delivered_via: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi('AgiTaskLiveness');

export const AgiLivenessViewSchema = z
  .object({ task: AgiTaskSchema, liveness: AgiTaskLivenessSchema })
  .openapi('AgiLivenessView');

export const AgiGoalLivenessSchema = z
  .object({
    state: z.enum(GOAL_LIVENESS_STATES),
    reason: z.enum(GOAL_STALL_REASONS).nullable(),
    flat_metrics: z.array(z.object({ metric: z.string(), flat_observations: z.number() })),
    /** The N this verdict used, so a caller never has to guess. */
    flat_stall_after: z.number(),
  })
  .openapi('AgiGoalLiveness');

export const AgiGoalLivenessViewSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    status: z.string(),
    liveness: AgiGoalLivenessSchema,
    metrics: z.array(AgiGoalMetricSchema),
  })
  .openapi('AgiGoalLivenessView');

export const AgiLivenessSchema = z
  .object({
    tasks: z.array(AgiLivenessViewSchema),
    stalled: z.array(AgiLivenessViewSchema),
    /** Stalled TASKS. Unchanged meaning — see the route. */
    stalled_count: z.number(),
    truncated: z.boolean(),
    goals: z.array(AgiGoalLivenessViewSchema),
    /** R-12e: every metric flat across at least `flat_stall_after` readings. */
    stalled_goals: z.array(AgiGoalLivenessViewSchema),
    stalled_goal_count: z.number(),
    /** R-12d: `done_when` names a threshold, nothing has ever been recorded. */
    unmeasurable_goals: z.array(AgiGoalLivenessViewSchema),
    unmeasurable_goal_count: z.number(),
    stalled_total: z.number(),
  })
  .openapi('AgiLiveness');

export const AgiLivenessSweepSchema = z
  .object({
    scanned: z.number(),
    stalled: z.number(),
    outcomes: z.array(
      z.object({
        task_id: z.string().uuid(),
        reason: z.string(),
        claim_released: z.boolean(),
        progressed: z.boolean(),
        recovery: z
          .object({
            step: z.enum(['continued', 'escalated', 'already_escalated']),
            fingerprint: z.string(),
            task_id: z.string().uuid().nullable(),
            escalated_to: z.string().uuid().nullable(),
          })
          .nullable(),
      }),
    ),
  })
  .openapi('AgiLivenessSweep');
