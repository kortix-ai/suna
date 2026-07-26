/**
 * OpenAPI shapes for the AGI goal surface. These document the wire contract in
 * /v1/docs; runtime validation stays in the handlers so the exact normative
 * error codes (`goal_no_push`, `goal_not_active`) survive instead of being
 * flattened into the shared zod-failure envelope.
 */
import { GOAL_STATUSES } from '../../projects/lib/agi-goals';
import { AgiTaskSchema } from '../tasks/schemas';
import { z } from '@hono/zod-openapi';

export const AgiGoalSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    done_when: z.string(),
    status: z.enum(GOAL_STATUSES as unknown as [string, ...string[]]),
    push: z.string().nullable(),
    agent: z.string(),
    timezone: z.string(),
    path: z.string(),
    trigger_slug: z.string().nullable(),
    task_counts: z.record(z.string(), z.number()),
    open_task_count: z.number(),
  })
  .openapi('AgiGoal');

export const AgiGoalIssueSchema = z
  .object({
    /** Ordinal in the `goals:` list, or -1 for a problem with the block itself. */
    index: z.number(),
    slug: z.string().nullable(),
    message: z.string(),
    path: z.string(),
  })
  .openapi('AgiGoalIssue');

export const AgiGoalListSchema = z
  .object({
    goals: z.array(AgiGoalSchema),
    /** Goals the manifest declares but the parser rejected. Reported, never
     *  fatal: one broken entry must not blank the list. */
    errors: z.array(AgiGoalIssueSchema),
  })
  .openapi('AgiGoalList');

export const AgiGoalTriggerSchema = z
  .object({
    slug: z.string(),
    enabled: z.boolean(),
    cron: z.string().nullable(),
    timezone: z.string(),
    session_mode: z.string().nullable(),
    agent: z.string(),
    last_fired_at: z.string().nullable(),
    last_status: z.string().nullable(),
    last_error: z.string().nullable(),
    last_attempt_at: z.string().nullable(),
  })
  .openapi('AgiGoalTrigger');

export const AgiGoalDetailSchema = z
  .object({
    goal: AgiGoalSchema,
    open_tasks: z.array(AgiTaskSchema),
    /** Live state of the trigger `push` desugars to, or null for an on-demand
     *  goal. */
    trigger: AgiGoalTriggerSchema.nullable(),
    /** Project-wide trigger pause — the commonest reason a live goal is not
     *  actually advancing. */
    triggers_paused: z.boolean(),
  })
  .openapi('AgiGoalDetail');

export const AgiGoalPushResultSchema = z
  .object({
    status: z.string(),
    trigger_slug: z.string(),
    session_id: z.string().nullable(),
    command_id: z.string().nullable(),
    deduped: z.boolean(),
    reason: z.string().nullable(),
  })
  .openapi('AgiGoalPushResult');

export const AgiGoalPushBodySchema = z.record(z.string(), z.any()).openapi('AgiGoalPushBody');
