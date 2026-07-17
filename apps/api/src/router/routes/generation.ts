import { createRoute, z } from '@hono/zod-openapi';
import { gatewayRequestLogs } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { combinedAuth } from '../../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { db } from '../../shared/db';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import type { AppEnv } from '../../types';
import { mapGatewayLogToGeneration } from './generation-mapper';

const generationApp = makeOpenApiApp<AppEnv>();

generationApp.use('*', combinedAuth);

const GenerationDataSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    requested_model: z.string(),
    provider: z.string(),
    streamed: z.boolean(),
    tokens_prompt: z.number(),
    tokens_completion: z.number(),
    tokens_cached: z.number(),
    total_cost: z.number(),
    upstream_cost: z.number(),
    latency_ms: z.number(),
    attempts: z.number(),
    status: z.number(),
    ok: z.boolean(),
    finish_reason: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('GenerationData');

const GenerationResponseSchema = z
  .object({ data: GenerationDataSchema })
  .openapi('GenerationResponse');

const GenerationQuerySchema = z
  .object({
    id: z.string().optional(),
    account_id: z.string().optional(),
  })
  .openapi('GenerationQuery');

generationApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['router'],
    summary:
      'GET /v1/generation?id=<requestId> — OpenRouter-parity forensics for a single gateway call',
    description:
      'Looks up one gateway_request_logs row by requestId, scoped to the authenticated account. ' +
      'Mirrors OpenRouter’s GET /generation `{ data: {...} }` envelope, adapted to our own columns.',
    ...auth,
    request: { query: GenerationQuerySchema },
    responses: {
      200: json(GenerationResponseSchema, 'Gateway request forensics'),
      ...errors(400, 401, 404),
    },
  }),
  async (c) => {
    const id = c.req.query('id');
    if (!id) {
      throw new HTTPException(400, { message: 'Missing required query parameter: id' });
    }

    const accountId = c.get('accountId') ?? (await resolveScopedAccountId(c, 'query'));

    const [row] = await db
      .select()
      .from(gatewayRequestLogs)
      .where(and(eq(gatewayRequestLogs.requestId, id), eq(gatewayRequestLogs.accountId, accountId)))
      .limit(1);

    if (!row) {
      throw new HTTPException(404, { message: `Generation ${id} not found` });
    }

    return c.json({ data: mapGatewayLogToGeneration(row) });
  },
);

export { generationApp };
