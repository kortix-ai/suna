import { TASK_WORKER_PLATFORM_CEILINGS } from '@kortix/db';
import { z } from '@hono/zod-openapi';

/**
 * Non-overridable server bounds. Meta agents and other callers may only narrow them.
 */
export const WORKER_CONTRACT_PLATFORM_CEILINGS = TASK_WORKER_PLATFORM_CEILINGS;

export const WorkerContractSchema = z
  .object({
    max_wall_seconds: z.number().int().positive().max(
      WORKER_CONTRACT_PLATFORM_CEILINGS.max_wall_seconds,
    ),
    max_tokens: z.number().int().positive().max(
      WORKER_CONTRACT_PLATFORM_CEILINGS.max_tokens,
    ),
    max_cost_usd: z.number().positive().finite().max(
      WORKER_CONTRACT_PLATFORM_CEILINGS.max_cost_usd,
    ),
    max_iterations: z.number().int().positive().max(
      WORKER_CONTRACT_PLATFORM_CEILINGS.max_iterations,
    ),
  })
  .strict();
