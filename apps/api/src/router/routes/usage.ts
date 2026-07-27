import { createRoute, z } from '@hono/zod-openapi';
import { usageEvents } from '@kortix/db';
import { type SQL, and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { combinedAuth } from '../../middleware/auth';
import { rejectSandboxTokens } from '../../middleware/reject-sandbox-tokens';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { db } from '../../shared/db';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import type { AppEnv } from '../../types';
import {
  InvalidUsageQueryError,
  type UsageQueryParams,
  mapUsageBreakdownRow,
  mapUsageTotals,
  parseUsageQuery,
} from './usage-query';

const usageApp = makeOpenApiApp<AppEnv>();

usageApp.use('*', combinedAuth);
// Sandbox agent tokens (kortix_ keys with a sandboxId) have no legitimate
// reason to read account-wide usage/cost rollups — without this they'd see
// every project's spend on multi-user accounts. See reject-sandbox-tokens.ts.
usageApp.use('*', rejectSandboxTokens);

const UsageTotalsSchema = z
  .object({
    total_input_tokens: z.number(),
    total_output_tokens: z.number(),
    total_cached_tokens: z.number(),
    total_cache_write_tokens: z.number(),
    total_cost: z.number(),
    count: z.number(),
  })
  .openapi('UsageTotals');

const UsageBreakdownItemSchema = z
  .object({
    day: z.string().optional(),
    provider: z.string().nullable().optional(),
    model: z.string().optional(),
    /** Present only for group_by=origin_ref (Kortix-as-a-Backend). */
    origin_ref: z.string().optional(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    cached_tokens: z.number(),
    cache_write_tokens: z.number(),
    cost: z.number(),
    count: z.number(),
  })
  .openapi('UsageBreakdownItem');

const UsageResponseSchema = z
  .object({
    data: UsageTotalsSchema,
    breakdown: z.array(UsageBreakdownItemSchema).optional(),
  })
  .openapi('UsageResponse');

const UsageQuerySchema = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
    group_by: z.enum(['model', 'provider', 'day', 'origin_ref']).optional(),
    account_id: z.string().optional(),
    /** Kortix-as-a-Backend: narrow to a single end-user of the wrapper. */
    origin_ref: z.string().optional(),
  })
  .openapi('UsageQuery');

usageApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['router'],
    summary: 'GET /v1/usage — OpenRouter-parity usage rollup, scoped to the authenticated account',
    description:
      'Aggregates usage_events for the caller’s account over an optional [start,end] window, ' +
      'with an optional breakdown grouped by model, provider, or day.',
    ...auth,
    request: { query: UsageQuerySchema },
    responses: {
      200: json(UsageResponseSchema, 'Usage rollup'),
      ...errors(400, 401),
    },
  }),
  async (c) => {
    let parsed: UsageQueryParams;
    try {
      parsed = parseUsageQuery({
        start: c.req.query('start'),
        end: c.req.query('end'),
        group_by: c.req.query('group_by'),
        origin_ref: c.req.query('origin_ref'),
      });
    } catch (err) {
      if (err instanceof InvalidUsageQueryError) {
        throw new HTTPException(400, { message: err.message });
      }
      throw err;
    }

    const accountId = c.get('accountId') ?? (await resolveScopedAccountId(c, 'query'));

    const conds: SQL[] = [eq(usageEvents.accountId, accountId)];
    if (parsed.start) conds.push(gte(usageEvents.createdAt, parsed.start));
    if (parsed.end) conds.push(lte(usageEvents.createdAt, parsed.end));
    // Narrowing to one end-user applies to the TOTALS as well as any breakdown —
    // `conds` is shared by every aggregate below, so a wrapper asking for one
    // user's spend never sees account-wide numbers in `data`.
    if (parsed.originRef) conds.push(eq(usageEvents.originRef, parsed.originRef));

    const [totalsRow] = await db
      .select({
        totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
        totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
        totalCachedTokens: sql<number>`coalesce(sum(${usageEvents.cachedTokens}), 0)`,
        totalCacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
        totalCost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        count: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(and(...conds));

    const data = mapUsageTotals(totalsRow);

    if (!parsed.groupBy) {
      return c.json({ data });
    }

    if (parsed.groupBy === 'origin_ref') {
      // Only attributed rows participate. Unattributed spend (everything that
      // isn't a backend session — the playground, the legacy router path, and
      // anything written before this column existed) has a NULL origin_ref and
      // is deliberately EXCLUDED rather than collapsed into one anonymous
      // bucket, which would read as a spurious "end-user" in the wrapper's
      // report. `data` still reflects the unfiltered account totals.
      const rows = await db
        .select({
          originRef: sql<string>`${usageEvents.originRef}`,
          inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
          cachedTokens: sql<number>`coalesce(sum(${usageEvents.cachedTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
          cost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          count: sql<number>`count(*)::int`,
        })
        .from(usageEvents)
        .where(and(...conds, isNotNull(usageEvents.originRef)))
        .groupBy(usageEvents.originRef)
        .orderBy(sql`coalesce(sum(${usageEvents.costUsd}), 0) desc`);
      return c.json({ data, breakdown: rows.map(mapUsageBreakdownRow) });
    }

    if (parsed.groupBy === 'day') {
      const rows = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
          inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
          cachedTokens: sql<number>`coalesce(sum(${usageEvents.cachedTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
          cost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          count: sql<number>`count(*)::int`,
        })
        .from(usageEvents)
        .where(and(...conds))
        .groupBy(sql`date_trunc('day', ${usageEvents.createdAt})`)
        .orderBy(sql`date_trunc('day', ${usageEvents.createdAt})`);
      return c.json({ data, breakdown: rows.map(mapUsageBreakdownRow) });
    }

    if (parsed.groupBy === 'model') {
      const rows = await db
        .select({
          provider: usageEvents.provider,
          model: usageEvents.model,
          inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
          cachedTokens: sql<number>`coalesce(sum(${usageEvents.cachedTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
          cost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          count: sql<number>`count(*)::int`,
        })
        .from(usageEvents)
        .where(and(...conds))
        .groupBy(usageEvents.provider, usageEvents.model)
        .orderBy(desc(sql`sum(${usageEvents.costUsd})`));
      return c.json({ data, breakdown: rows.map(mapUsageBreakdownRow) });
    }

    // groupBy === 'provider'
    const rows = await db
      .select({
        provider: usageEvents.provider,
        inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${usageEvents.cachedTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
        cost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        count: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(and(...conds))
      .groupBy(usageEvents.provider)
      .orderBy(desc(sql`sum(${usageEvents.costUsd})`));
    return c.json({ data, breakdown: rows.map(mapUsageBreakdownRow) });
  },
);

export { usageApp };
