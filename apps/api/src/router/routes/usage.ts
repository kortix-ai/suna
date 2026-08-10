import { createRoute, z } from '@hono/zod-openapi';
import { usageEvents } from '@kortix/db';
import { type SQL, and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WORKSPACE_ACTIONS } from '../../iam/actions';
import { combinedAuth } from '../../middleware/auth';
import { rejectSandboxTokens } from '../../middleware/reject-sandbox-tokens';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { assertWorkspaceCapability, loadWorkspaceForUser } from '../../workspaces/lib/access';
import { CSV_ROW_CAP, toCsv } from '../../shared/cost-csv';
import { getCostSummary, listCostByWorkspace } from '../../shared/cost-rollups';
import {
  type CostSort,
  type CostWindow,
  InvalidCostQueryError,
  parseCostPagination,
  parseCostSort,
  parseCostWindow,
} from '../../shared/cost-window';
import { db } from '../../shared/db';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { getSessionCostRecord, listSessionCosts } from '../../shared/session-costs';
import type { AppEnv } from '../../types';
import {
  InvalidUsageQueryError,
  type UsageQueryParams,
  mapUsageBreakdownRow,
  mapUsageTotals,
  parseUsageQuery,
} from './usage-query';

// The route's allowed sorts. Deliberately excludes `name_asc`: CostSort is
// shared with the project-level rollup, but a session page has no name to
// sort on and sessionCostSortKey throws for it by design. Keeping it out of
// this list is what makes that a clean 400 (rejected by parseCostSort before
// listSessionCosts ever runs) instead of a 500.
export const SESSION_COST_SORTS: readonly CostSort[] = ['total_desc', 'total_asc', 'recent'];

const usageApp = makeOpenApiApp<AppEnv>();

usageApp.use('*', combinedAuth);
// Sandbox agent tokens (kortix_ keys with a sandboxId) have no legitimate
// reason to read account-wide usage/cost rollups — without this they'd see
// every project's spend on multi-user accounts. See reject-sandbox-tokens.ts.
usageApp.use('*', rejectSandboxTokens);

async function resolveSessionCostAccountId(
  c: Context<AppEnv>,
  workspaceId?: string,
): Promise<string> {
  const tokenAccountId = c.get('accountId');
  if (tokenAccountId) return tokenAccountId;

  if (c.req.query('account_id') || !workspaceId) {
    return resolveScopedAccountId(c, 'query');
  }

  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) {
    throw new HTTPException(404, { message: 'Workspace not found' });
  }
  await assertWorkspaceCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    workspaceId,
    WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ,
  );
  return loaded.row.accountId;
}

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
    group_by: z.enum(['model', 'provider', 'day']).optional(),
    account_id: z.string().optional(),
  })
  .openapi('UsageQuery');

const SessionCostSummarySchema = z
  .object({
    session_id: z.string(),
    workspace_id: z.string(),
    workspace_name: z.string(),
    // Retained response aliases for existing direct API consumers.
    project_id: z.string(),
    project_name: z.string(),
    owner_id: z.string().nullable(),
    owner_type: z.enum(['user', 'service_account', 'unknown']).nullable(),
    owner_name: z.string().nullable(),
    owner_email: z.string().nullable(),
    status: z.enum([
      'queued',
      'branching',
      'provisioning',
      'running',
      'stopped',
      'failed',
      'completed',
    ]),
    created_at: z.string(),
    updated_at: z.string(),
    last_activity_at: z.string().nullable(),
    llm_cost: z.number(),
    compute_cost: z.number(),
    total_cost: z.number(),
    request_count: z.number(),
    error_count: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    cached_tokens: z.number(),
    cache_write_tokens: z.number(),
    model_count: z.number(),
    compute_seconds: z.number(),
  })
  .openapi('SessionCostSummary');

const SessionCostReconciliationSchema = z
  .object({
    llm_cost: z.number(),
    compute_cost: z.number(),
    total_cost: z.number(),
    request_count: z.number(),
    compute_window_count: z.number(),
    compute_seconds: z.number(),
  })
  .openapi('SessionCostReconciliation');

const SessionCostModelUsageSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    request_count: z.number(),
    error_count: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    cached_tokens: z.number(),
    cache_write_tokens: z.number(),
    cost: z.number(),
    last_at: z.string(),
  })
  .openapi('SessionCostModelUsage');

const SessionCostLlmLedgerEntrySchema = z
  .object({
    kind: z.literal('llm'),
    id: z.string(),
    occurred_at: z.string(),
    cost: z.number(),
    provider: z.string(),
    model: z.string(),
    request_id: z.string(),
    status: z.number(),
    ok: z.boolean(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    cached_tokens: z.number(),
    cache_write_tokens: z.number(),
  })
  .openapi('SessionCostLlmLedgerEntry');

const SessionCostComputeLedgerEntrySchema = z
  .object({
    kind: z.literal('compute'),
    id: z.string(),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    billed_through_at: z.string(),
    cost: z.number(),
    provider: z.string(),
    state: z.string(),
    compute_seconds: z.number(),
    cpu_cores: z.number(),
    memory_gb: z.number(),
    disk_gb: z.number(),
    gpu_count: z.number(),
  })
  .openapi('SessionCostComputeLedgerEntry');

const SessionCostDetailSchema = SessionCostSummarySchema.extend({
  model_usage: z.array(SessionCostModelUsageSchema),
  ledger_entries: z.array(
    z.discriminatedUnion('kind', [
      SessionCostLlmLedgerEntrySchema,
      SessionCostComputeLedgerEntrySchema,
    ]),
  ),
}).openapi('SessionCostDetail');

const SessionCostListResponseSchema = z
  .object({
    sessions: z.array(SessionCostSummarySchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    next_offset: z.number().nullable(),
    reconciliation: SessionCostReconciliationSchema,
  })
  .openapi('SessionCostListResponse');

const SessionCostListQuerySchema = z
  .object({
    account_id: z.string().optional(),
    workspace_id: z.string().optional(),
    project_id: z.string().optional(),
    owner_id: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    sort: z.enum(['total_desc', 'total_asc', 'recent']).optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
    format: z.enum(['csv']).optional(),
  })
  .openapi('SessionCostListQuery');

const SessionCostDetailQuerySchema = z
  .object({
    account_id: z.string().optional(),
    workspace_id: z.string().optional(),
    project_id: z.string().optional(),
  })
  .openapi('SessionCostDetailQuery');

const WorkspaceCostRowSchema = z
  .object({
    project_id: z.string(),
    project_name: z.string(),
    session_count: z.number(),
    llm_cost: z.number(),
    compute_cost: z.number(),
    total_cost: z.number(),
    last_activity_at: z.string().nullable(),
  })
  .openapi('WorkspaceCostRow');

const WorkspaceCostPageSchema = z
  .object({
    projects: z.array(WorkspaceCostRowSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    next_offset: z.number().nullable(),
  })
  .openapi('WorkspaceCostPage');

const CanonicalWorkspaceCostRowSchema = z
  .object({
    workspace_id: z.string(),
    workspace_name: z.string(),
    session_count: z.number(),
    llm_cost: z.number(),
    compute_cost: z.number(),
    total_cost: z.number(),
    last_activity_at: z.string().nullable(),
  })
  .openapi('CanonicalWorkspaceCostRow');

const CanonicalWorkspaceCostPageSchema = z
  .object({
    workspaces: z.array(CanonicalWorkspaceCostRowSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    next_offset: z.number().nullable(),
  })
  .openapi('CanonicalWorkspaceCostPage');

// The route's allowed sorts — all four CostSort members. Unlike
// SESSION_COST_SORTS, this includes name_asc: a project rollup has a name to
// sort on, so sortWorkspaceRows never hits its `never`-typed default branch.
// `as const` (not `: readonly CostSort[]`) so the same array satisfies both
// z.enum()'s non-empty-tuple requirement below and parseCostSort()'s
// `readonly CostSort[]` parameter.
const WORKSPACE_COST_SORTS = ['total_desc', 'total_asc', 'recent', 'name_asc'] as const;

const WorkspaceCostQuerySchema = z
  .object({
    account_id: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    sort: z.enum(WORKSPACE_COST_SORTS).optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
    format: z.enum(['csv']).optional(),
  })
  .openapi('WorkspaceCostQuery');

function readWorkspaceIdQuery(c: Context<AppEnv>): string | undefined {
  const workspaceId = c.req.query('workspace_id') || undefined;
  const projectId = c.req.query('project_id') || undefined;
  if (workspaceId && projectId && workspaceId !== projectId) {
    throw new HTTPException(400, {
      message: 'workspace_id and deprecated project_id must match when both are supplied',
    });
  }
  return workspaceId ?? projectId;
}

function withWorkspaceIdentity<T extends { project_id: string; project_name: string }>(row: T) {
  return {
    ...row,
    workspace_id: row.project_id,
    workspace_name: row.project_name,
  };
}

const CostSummaryTotalsSchema = z
  .object({
    llm_cost: z.number(),
    compute_cost: z.number(),
    total_cost: z.number(),
    request_count: z.number(),
    compute_seconds: z.number(),
    session_count: z.number(),
    project_count: z.number(),
  })
  .openapi('CostSummaryTotals');

const CostSeriesPointSchema = z
  .object({
    day: z.string(),
    llm_cost: z.number(),
    compute_cost: z.number(),
    total_cost: z.number(),
  })
  .openapi('CostSeriesPoint');

const CostModelRowSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    cost: z.number(),
    request_count: z.number(),
  })
  .openapi('CostModelRow');

const CostSummarySchema = z
  .object({
    totals: CostSummaryTotalsSchema,
    previous: z.object({ total_cost: z.number() }).openapi('CostSummaryPrevious'),
    series: z.array(CostSeriesPointSchema),
    models: z.array(CostModelRowSchema),
  })
  .openapi('CostSummary');

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

usageApp.openapi(
  createRoute({
    method: 'get',
    path: '/session-costs',
    tags: ['usage'],
    summary: 'List session costs for one account',
    description:
      'Lists every project session, including zero-cost sessions, with LLM and billed ' +
      'compute totals over a date window. LLM cost is windowed on request time ' +
      '(created_at); compute cost is windowed on the billing window start (started_at). ' +
      'Bounds are half-open [from, to) and always UTC; an absent from/to defaults to the ' +
      'trailing 30 days. ' +
      '`reconciliation` covers spend the account cannot attribute to any session in the ' +
      'same window: per-session totals attribute LLM cost by session_id, but ' +
      '`reconciliation` attributes it by the nullable gateway_request_logs.project_id, ' +
      'because by definition no session_id match exists. A project-scoped ' +
      'reconciliation figure and the per-session table beside it can therefore ' +
      'legitimately disagree.',
    ...auth,
    request: { query: SessionCostListQuerySchema },
    responses: {
      200: {
        description:
          'Paginated session cost summaries, or (format=csv) the same filtered rows as a ' +
          'CSV attachment capped at CSV_ROW_CAP.',
        content: {
          'application/json': { schema: SessionCostListResponseSchema },
          'text/csv': { schema: z.string() },
        },
      },
      ...errors(400, 401, 403),
    },
  }),
  async (c) => {
    let parsed: {
      window: CostWindow;
      sort: CostSort;
      limit: number;
      offset: number;
    };
    try {
      parsed = {
        window: parseCostWindow({ from: c.req.query('from'), to: c.req.query('to') }),
        sort: parseCostSort(c.req.query('sort'), SESSION_COST_SORTS, 'total_desc'),
        ...parseCostPagination({ limit: c.req.query('limit'), offset: c.req.query('offset') }),
      };
    } catch (error) {
      if (error instanceof InvalidCostQueryError) {
        throw new HTTPException(400, { message: error.message });
      }
      throw error;
    }

    const workspaceId = readWorkspaceIdQuery(c);
    const ownerId = c.req.query('owner_id') || undefined;
    const accountId = await resolveSessionCostAccountId(c, workspaceId);

    if (c.req.query('format') === 'csv') {
      // Same filtered query as the JSON branch (accountId, workspaceId, ownerId,
      // window, sort) — only limit/offset differ, because a CSV export wants
      // up to CSV_ROW_CAP rows in one shot, not one paginated page of it.
      const page = await listSessionCosts({
        accountId,
        workspaceId,
        ownerId,
        window: parsed.window,
        sort: parsed.sort,
        limit: CSV_ROW_CAP,
        offset: 0,
      });
      const body = toCsv(
        [
          'session_id',
          'project_name',
          'owner',
          'status',
          'requests',
          'llm_cost_usd',
          'compute_cost_usd',
          'total_cost_usd',
          'last_activity_at',
        ],
        page.sessions.map((row) => [
          row.session_id,
          row.project_name,
          // owner_name is the resolved display label (it already falls back
          // to owner_email when a user has no name set — see
          // resolveSessionOwnerIdentities), so one "owner" column reuses it
          // instead of the route picking its own fallback across
          // owner_name/owner_email/owner_id.
          row.owner_name,
          row.status,
          row.request_count,
          row.llm_cost,
          row.compute_cost,
          row.total_cost,
          row.last_activity_at,
        ]),
      );
      return c.body(body, 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="kortix-session-costs.csv"',
        'x-kortix-row-cap': String(CSV_ROW_CAP),
      });
    }

    const page = await listSessionCosts({ accountId, workspaceId, ownerId, ...parsed });
    return c.json({ ...page, sessions: page.sessions.map(withWorkspaceIdentity) });
  },
);

usageApp.openapi(
  createRoute({
    method: 'get',
    path: '/session-costs/{sessionId}',
    tags: ['usage'],
    summary: 'Get one session cost ledger',
    description:
      'Returns one account-scoped session summary with model usage and LLM/compute ledger entries.',
    ...auth,
    request: {
      params: z.object({ sessionId: z.string().min(1) }),
      query: SessionCostDetailQuerySchema,
    },
    responses: {
      200: json(SessionCostDetailSchema, 'Session cost detail'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c) => {
    const workspaceId = readWorkspaceIdQuery(c);
    const accountId = await resolveSessionCostAccountId(c, workspaceId);
    const detail = await getSessionCostRecord({
      accountId,
      workspaceId,
      sessionId: c.req.param('sessionId'),
    });
    if (!detail) {
      throw new HTTPException(404, { message: 'Session not found' });
    }
    return c.json(withWorkspaceIdentity(detail));
  },
);

async function handleWorkspaceCostRollup(
  c: Context<AppEnv>,
  representation: 'workspace' | 'project',
): Promise<Response> {
    let accountId: string;
    let window: CostWindow;
    let sort: CostSort;
    let limit: number;
    let offset: number;
    try {
      // accountId resolves FIRST, exactly as it did before format=csv existed
      // — resolveScopedAccountId can throw HTTPException(403), which this
      // catch block does not intercept (it only maps InvalidCostQueryError to
      // 400) and lets propagate as-is. Parsing window/sort/pagination first
      // would let an invalid window on a request the caller cannot access
      // surface as 400 instead of 403 — telling an unauthorized caller which
      // of their parameters was malformed. Authorization must be decided
      // before input validation, not after.
      accountId = c.get('accountId') ?? (await resolveScopedAccountId(c, 'query'));
      window = parseCostWindow({ from: c.req.query('from'), to: c.req.query('to') });
      sort = parseCostSort(c.req.query('sort'), WORKSPACE_COST_SORTS, 'total_desc');
      ({ limit, offset } = parseCostPagination({
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
      }));
    } catch (error) {
      if (error instanceof InvalidCostQueryError) {
        throw new HTTPException(400, { message: error.message });
      }
      throw error;
    }

    if (c.req.query('format') === 'csv') {
      // Same filtered query as the JSON branch (accountId, window, sort) —
      // only limit/offset differ, because a CSV export wants up to
      // CSV_ROW_CAP rows in one shot, not one paginated page of it.
      const page = await listCostByWorkspace({
        accountId,
        window,
        sort,
        limit: CSV_ROW_CAP,
        offset: 0,
      });
      const canonical = representation === 'workspace';
      const body = toCsv(
        [
          canonical ? 'workspace_id' : 'project_id',
          canonical ? 'workspace_name' : 'project_name',
          'sessions',
          'llm_cost_usd',
          'compute_cost_usd',
          'total_cost_usd',
          'last_activity_at',
        ],
        page.projects.map((row) => [
          row.project_id,
          row.project_name,
          row.session_count,
          row.llm_cost,
          row.compute_cost,
          row.total_cost,
          row.last_activity_at,
        ]),
      );
      return c.body(body, 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="kortix-cost-by-${representation}.csv"`,
        'x-kortix-row-cap': String(CSV_ROW_CAP),
      });
    }

    const page = await listCostByWorkspace({ accountId, window, sort, limit, offset });
    if (representation === 'project') return c.json(page);
    return c.json({
      workspaces: page.projects
        .map(withWorkspaceIdentity)
        .map(({ project_id, project_name, ...row }) => row),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      next_offset: page.next_offset,
    });
}

usageApp.openapi(
  createRoute({
    method: 'get',
    path: '/cost-by-workspace',
    tags: ['usage'],
    summary: 'Roll up spend by workspace over a date window',
    description:
      'Groups LLM and billed compute spend by Workspace. Bounds are half-open [from, to) ' +
      'and always UTC. An absent from/to defaults to the trailing 30 days.',
    ...auth,
    request: { query: WorkspaceCostQuerySchema },
    responses: {
      200: {
        description:
          'Workspace spend rollup, or (format=csv) the same filtered rows as a CSV attachment.',
        content: {
          'application/json': { schema: CanonicalWorkspaceCostPageSchema },
          'text/csv': { schema: z.string() },
        },
      },
      ...errors(400, 401, 403),
    },
  }),
  async (c) => handleWorkspaceCostRollup(c, 'workspace'),
);

usageApp.openapi(
  createRoute({
    method: 'get',
    path: '/cost-by-project',
    tags: ['usage'],
    summary: 'Deprecated: roll up spend by project over a date window',
    description: 'Deprecated compatibility alias for GET /v1/usage/cost-by-workspace.',
    deprecated: true,
    ...auth,
    request: { query: WorkspaceCostQuerySchema },
    responses: {
      200: {
        description: 'Legacy Project spend rollup or CSV export.',
        content: {
          'application/json': { schema: WorkspaceCostPageSchema },
          'text/csv': { schema: z.string() },
        },
      },
      ...errors(400, 401, 403),
    },
  }),
  async (c) => handleWorkspaceCostRollup(c, 'project'),
);

usageApp.openapi(
  createRoute({
    method: 'get',
    path: '/cost-summary',
    tags: ['usage'],
    summary: 'Spend totals, daily series and model breakdown over a date window',
    description:
      'Scoped to the account, or to one workspace or session when workspace_id / session_id is ' +
      'supplied. LLM is windowed on request time (created_at); compute is windowed on the ' +
      'billing window start (started_at), never last_billed_at. Bounds are half-open ' +
      '[from, to) and always UTC; an absent from/to defaults to the trailing 30 days. Day ' +
      'buckets in `series` are UTC and gap days are zero-filled, never omitted. `previous` ' +
      'covers the equally long window immediately before [from, to). The account-scoped ' +
      '(no workspace_id / session_id) `totals.total_cost` covers ALL account spend in the ' +
      'window, including compute cost not attributable to any workspace. The deprecated ' +
      'project_id query alias remains accepted.',
    ...auth,
    request: {
      query: z
        .object({
          account_id: z.string().optional(),
          workspace_id: z.string().optional(),
          project_id: z.string().optional(),
          session_id: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .openapi('CostSummaryQuery'),
    },
    responses: { 200: json(CostSummarySchema, 'Cost summary'), ...errors(400, 401, 403) },
  }),
  async (c) => {
    try {
      const workspaceId = readWorkspaceIdQuery(c);
      const accountId = await resolveSessionCostAccountId(c, workspaceId);
      return c.json(
        await getCostSummary({
          accountId,
          workspaceId,
          sessionId: c.req.query('session_id') || undefined,
          window: parseCostWindow({ from: c.req.query('from'), to: c.req.query('to') }),
        }),
      );
    } catch (error) {
      if (error instanceof InvalidCostQueryError) {
        throw new HTTPException(400, { message: error.message });
      }
      throw error;
    }
  },
);

export { usageApp };
