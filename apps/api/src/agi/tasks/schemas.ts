/**
 * OpenAPI shapes for the AGI task surface. These document the wire contract in
 * /v1/docs; runtime validation stays in the handlers so the exact normative
 * error messages (`two_assignees`, `claim_conflict`, …) survive instead of being
 * flattened into the shared zod-failure envelope.
 */
import { TASK_ORIGINS, TASK_PRIORITIES, TASK_STATUSES } from './wire';
import { z } from '@hono/zod-openapi';

export const AgiTaskSchema = z
  .object({
    task_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    parent_id: z.string().uuid().nullable(),
    goal_slug: z.string().nullable(),
    project: z.string().nullable(),
    title: z.string(),
    body: z.string().nullable(),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    agent: z.string().nullable(),
    assignee_user_id: z.string().uuid().nullable(),
    blocked_by: z.array(z.string().uuid()),
    trigger_slug: z.string().nullable(),
    claim_session_id: z.string().nullable(),
    claimed_at: z.string().nullable(),
    claim_expires_at: z.string().nullable(),
    claimed: z.boolean(),
    origin: z.enum(TASK_ORIGINS),
    origin_fingerprint: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('AgiTask');

export const AgiTaskListSchema = z
  .object({
    tasks: z.array(AgiTaskSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('AgiTaskList');

export const AgiTaskDetailSchema = z
  .object({
    task: AgiTaskSchema,
    children: z.array(AgiTaskSchema),
    blockers: z.array(AgiTaskSchema),
    missing_blockers: z.array(z.string().uuid()),
  })
  .openapi('AgiTaskDetail');

export const AgiTaskCreateResultSchema = z
  .object({ task: AgiTaskSchema, created: z.boolean() })
  .openapi('AgiTaskCreateResult');

export const AgiTaskResultSchema = z.object({ task: AgiTaskSchema }).openapi('AgiTaskResult');

export const AgiTaskClaimResultSchema = z
  .object({ task: AgiTaskSchema, claimed: z.literal(true) })
  .openapi('AgiTaskClaimResult');

export const AgiTaskReleaseResultSchema = z
  .object({ task: AgiTaskSchema, released: z.literal(true) })
  .openapi('AgiTaskReleaseResult');

/** Bodies stay permissive in the spec because the handlers own validation. */
export const AgiTaskBodySchema = z.record(z.string(), z.any()).openapi('AgiTaskBody');
