import { z } from '@hono/zod-openapi';

/** Maximum value accepted by PostgreSQL's integer type. */
export const MAX_TASK_ITERATIONS = 2_147_483_647;

export const WorkerContractSchema = z
  .object({
    max_wall_seconds: z.number().int().positive().max(86_400),
    max_tokens: z.number().int().positive().safe(),
    max_cost_usd: z.number().positive().finite(),
    max_iterations: z.number().int().positive().max(MAX_TASK_ITERATIONS),
  })
  .strict();
