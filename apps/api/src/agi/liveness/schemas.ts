/**
 * OpenAPI shapes for the stall surface. Documentation only — the handlers own
 * validation, exactly as the task routes do, so the normative error strings
 * survive instead of being flattened into the shared zod-failure envelope.
 */
import { AgiTaskSchema } from '../tasks/schemas';
import { LIVENESS_STATES, STALL_REASONS } from './wire';
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
  })
  .openapi('AgiTaskLiveness');

export const AgiLivenessViewSchema = z
  .object({ task: AgiTaskSchema, liveness: AgiTaskLivenessSchema })
  .openapi('AgiLivenessView');

export const AgiLivenessSchema = z
  .object({
    tasks: z.array(AgiLivenessViewSchema),
    stalled: z.array(AgiLivenessViewSchema),
    stalled_count: z.number(),
    truncated: z.boolean(),
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
