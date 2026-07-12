import { and, desc, eq, sql } from 'drizzle-orm';
import { createRoute, z } from '@hono/zod-openapi';
import { gatewayBudgets, gatewayRequestLogs, sandboxComputeSessions, sessionSandboxes } from '@kortix/db';
import { calculateCost, callUpstream, type AuthedPrincipal } from '@kortix/llm-gateway';
import { resolveCandidates } from '../../llm-gateway/resolution/resolve-candidates';
import { db } from '../../shared/db';
import { auth, errors, json } from '../../openapi';
import { authorize } from '../../iam';
import { deriveRequestContext } from '../../iam/cache';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser, lookupEmailsByUserIds } from '../lib/access';
import { projectsApp } from '../lib/app';
import { UUID_V4_REGEX } from '../lib/serializers';
import { createGatewayKey, listGatewayKeys, revokeGatewayKey } from '../../llm-gateway/gateway-keys';
import {
  assertGatewayBudget,
  persistGatewayTrace,
  recordGatewayUsage,
} from '../../llm-gateway/hooks';
import { publicGatewayBaseUrl } from '../../llm-gateway/public-url';
import { config } from '../../config';

async function canDo(c: any, projectId: string, accountId: string, action: string): Promise<boolean> {
  const verdict = await authorize(
    c.get('userId'),
    accountId,
    action,
    { type: 'project', id: projectId },
    c.get('iamTokenId'),
    deriveRequestContext(c),
  );
  return verdict.allowed;
}

const canSetBudget = (c: any, projectId: string, accountId: string) =>
  canDo(c, projectId, accountId, PROJECT_ACTIONS.PROJECT_GATEWAY_BUDGET_SET);
const canManageKeys = (c: any, projectId: string, accountId: string) =>
  canDo(c, projectId, accountId, PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE);

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 100;

const LIST_COLUMNS = {
  logId: gatewayRequestLogs.logId,
  requestId: gatewayRequestLogs.requestId,
  createdAt: gatewayRequestLogs.createdAt,
  requestedModel: gatewayRequestLogs.requestedModel,
  resolvedModel: gatewayRequestLogs.resolvedModel,
  provider: gatewayRequestLogs.provider,
  status: gatewayRequestLogs.status,
  ok: gatewayRequestLogs.ok,
  errorCode: gatewayRequestLogs.errorCode,
  errorMessage: gatewayRequestLogs.errorMessage,
  latencyMs: gatewayRequestLogs.latencyMs,
  attempts: gatewayRequestLogs.attempts,
  inputTokens: gatewayRequestLogs.inputTokens,
  outputTokens: gatewayRequestLogs.outputTokens,
  cachedTokens: gatewayRequestLogs.cachedTokens,
  upstreamCost: gatewayRequestLogs.upstreamCost,
  finalCost: gatewayRequestLogs.finalCost,
  streaming: gatewayRequestLogs.streaming,
  billingMode: gatewayRequestLogs.billingMode,
  actorUserId: gatewayRequestLogs.actorUserId,
  keyId: gatewayRequestLogs.keyId,
};

function serializeLogRow(r: Record<string, any>) {
  return {
    log_id: r.logId,
    request_id: r.requestId,
    created_at: r.createdAt,
    requested_model: r.requestedModel,
    resolved_model: r.resolvedModel,
    provider: r.provider,
    status: r.status,
    ok: r.ok,
    error_code: r.errorCode,
    error_message: r.errorMessage,
    latency_ms: r.latencyMs,
    attempts: r.attempts,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cached_tokens: r.cachedTokens,
    upstream_cost: Number(r.upstreamCost ?? 0),
    final_cost: Number(r.finalCost ?? 0),
    streaming: r.streaming,
    billing_mode: r.billingMode,
    actor_user_id: r.actorUserId,
    key_id: r.keyId,
  };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/logs',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/logs',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({
        limit: z.string().optional(),
        offset: z.string().optional(),
        ok: z.enum(['true', 'false']).optional(),
      }),
    },
    responses: { 200: json(z.any(), 'Gateway request logs'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ);

    const limit = Math.min(Math.max(Number(c.req.query('limit')) || LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const okFilter = c.req.query('ok');

    const conds = [eq(gatewayRequestLogs.projectId, projectId)];
    if (okFilter === 'true') conds.push(eq(gatewayRequestLogs.ok, true));
    if (okFilter === 'false') conds.push(eq(gatewayRequestLogs.ok, false));

    const rows = await db
      .select(LIST_COLUMNS)
      .from(gatewayRequestLogs)
      .where(and(...conds))
      .orderBy(desc(gatewayRequestLogs.createdAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({ logs: page.map(serializeLogRow), next_offset: hasMore ? offset + limit : null });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/logs/{logId}',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/logs/:logId',
    ...auth,
    request: { params: z.object({ projectId: z.string(), logId: z.string() }) },
    responses: { 200: json(z.any(), 'Gateway request log detail'), ...errors(400, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const logId = c.req.param('logId');
    if (!UUID_V4_REGEX.test(logId)) return c.json({ error: 'Invalid log id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ);

    const [row] = await db
      .select()
      .from(gatewayRequestLogs)
      .where(and(eq(gatewayRequestLogs.logId, logId), eq(gatewayRequestLogs.projectId, projectId)))
      .limit(1);
    if (!row) return c.json({ error: 'Not found' }, 404);

    return c.json({
      ...serializeLogRow(row),
      candidates_tried: row.candidatesTried ?? [],
      request: row.request ?? null,
      response: row.response ?? null,
      metadata: row.metadata ?? {},
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/overview',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/overview',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ days: z.string().optional() }),
    },
    responses: { 200: json(z.any(), 'Gateway usage overview'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ);

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    const [agg] = await db
      .select({
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ok)::int`,
        totalCost: sql<number>`coalesce(sum(final_cost), 0)::float8`,
        inputTokens: sql<string>`coalesce(sum(input_tokens), 0)`,
        outputTokens: sql<string>`coalesce(sum(output_tokens), 0)`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.projectId, projectId),
          sql`${gatewayRequestLogs.createdAt} >= now() - make_interval(days => ${days})`,
        ),
      );

    return c.json({
      window_days: days,
      requests: agg?.requests ?? 0,
      errors: agg?.errors ?? 0,
      total_cost: agg?.totalCost ?? 0,
      input_tokens: Number(agg?.inputTokens ?? 0),
      output_tokens: Number(agg?.outputTokens ?? 0),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/series',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/series',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ days: z.string().optional() }),
    },
    responses: { 200: json(z.any(), 'Gateway daily usage series'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ);

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    const rows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${gatewayRequestLogs.createdAt}), 'YYYY-MM-DD')`,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        inputTokens: sql<string>`coalesce(sum(${gatewayRequestLogs.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${gatewayRequestLogs.outputTokens}), 0)`,
        p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${gatewayRequestLogs.latencyMs}), 0)::int`,
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${gatewayRequestLogs.latencyMs}), 0)::int`,
        p99: sql<number>`coalesce(percentile_cont(0.99) within group (order by ${gatewayRequestLogs.latencyMs}), 0)::int`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.projectId, projectId),
          sql`${gatewayRequestLogs.createdAt} >= now() - make_interval(days => ${days})`,
        ),
      )
      .groupBy(sql`date_trunc('day', ${gatewayRequestLogs.createdAt})`)
      .orderBy(sql`date_trunc('day', ${gatewayRequestLogs.createdAt})`);

    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series: {
      day: string;
      requests: number;
      errors: number;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      p50: number;
      p95: number;
      p99: number;
    }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const r = byDay.get(key);
      series.push({
        day: key,
        requests: r?.requests ?? 0,
        errors: r?.errors ?? 0,
        cost: r?.cost ?? 0,
        input_tokens: Number(r?.inputTokens ?? 0),
        output_tokens: Number(r?.outputTokens ?? 0),
        p50: r?.p50 ?? 0,
        p95: r?.p95 ?? 0,
        p99: r?.p99 ?? 0,
      });
    }
    return c.json({ window_days: days, series });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/sessions',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/sessions',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ days: z.string().optional() }),
    },
    responses: { 200: json(z.any(), 'Gateway spend by session'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ);

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);

    const [llmRows, computeRows] = await Promise.all([
      db
        .select({
          sessionId: gatewayRequestLogs.sessionId,
          requests: sql<number>`count(*)::int`,
          errors: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
          cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
          tokens: sql<string>`coalesce(sum(${gatewayRequestLogs.inputTokens} + ${gatewayRequestLogs.outputTokens}), 0)`,
          models: sql<number>`count(distinct ${gatewayRequestLogs.requestedModel})::int`,
          lastAt: sql<string>`max(${gatewayRequestLogs.createdAt})`,
        })
        .from(gatewayRequestLogs)
        .where(
          and(
            eq(gatewayRequestLogs.projectId, projectId),
            sql`${gatewayRequestLogs.sessionId} is not null`,
            sql`${gatewayRequestLogs.createdAt} >= now() - make_interval(days => ${days})`,
          ),
        )
        .groupBy(gatewayRequestLogs.sessionId),
      db
        .select({
          sessionId: sandboxComputeSessions.sessionId,
          cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
          seconds: sql<string>`coalesce(sum(extract(epoch from coalesce(${sandboxComputeSessions.endedAt}, ${sandboxComputeSessions.lastBilledAt}, now()) - ${sandboxComputeSessions.startedAt})), 0)::bigint`,
          lastAt: sql<string>`max(${sandboxComputeSessions.lastBilledAt})`,
        })
        .from(sandboxComputeSessions)
        .innerJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, sandboxComputeSessions.sessionId))
        .where(
          and(
            eq(sessionSandboxes.projectId, projectId),
            sql`${sandboxComputeSessions.sessionId} is not null`,
            sql`${sandboxComputeSessions.startedAt} >= now() - make_interval(days => ${days})`,
          ),
        )
        .groupBy(sandboxComputeSessions.sessionId),
    ]);

    type Row = {
      session_id: string;
      llm_cost: number;
      compute_cost: number;
      requests: number;
      errors: number;
      tokens: number;
      models: number;
      compute_seconds: number;
      last_at: string | null;
    };
    const bySession = new Map<string, Row>();
    for (const r of llmRows) {
      if (!r.sessionId) continue;
      bySession.set(r.sessionId, {
        session_id: r.sessionId,
        llm_cost: r.cost,
        compute_cost: 0,
        requests: r.requests,
        errors: r.errors,
        tokens: Number(r.tokens),
        models: r.models,
        compute_seconds: 0,
        last_at: r.lastAt,
      });
    }
    for (const r of computeRows) {
      if (!r.sessionId) continue;
      const e = bySession.get(r.sessionId) ?? {
        session_id: r.sessionId,
        llm_cost: 0,
        compute_cost: 0,
        requests: 0,
        errors: 0,
        tokens: 0,
        models: 0,
        compute_seconds: 0,
        last_at: null,
      };
      e.compute_cost = r.cost;
      e.compute_seconds = Number(r.seconds);
      if (r.lastAt && (!e.last_at || r.lastAt > e.last_at)) e.last_at = r.lastAt;
      bySession.set(r.sessionId, e);
    }

    const sessions = [...bySession.values()]
      .map((e) => ({ ...e, total_cost: e.llm_cost + e.compute_cost }))
      .sort((a, b) => b.total_cost - a.total_cost)
      .slice(0, 50);

    return c.json({ window_days: days, sessions });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/breakdown',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/breakdown',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ days: z.string().optional() }),
    },
    responses: { 200: json(z.any(), 'Gateway usage by model'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ);

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    const rows = await db
      .select({
        model: gatewayRequestLogs.requestedModel,
        provider: gatewayRequestLogs.provider,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        tokens: sql<string>`coalesce(sum(${gatewayRequestLogs.inputTokens} + ${gatewayRequestLogs.outputTokens}), 0)`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.projectId, projectId),
          sql`${gatewayRequestLogs.createdAt} >= now() - make_interval(days => ${days})`,
        ),
      )
      .groupBy(gatewayRequestLogs.requestedModel, gatewayRequestLogs.provider)
      .orderBy(desc(sql`count(*)`))
      .limit(12);

    return c.json({
      window_days: days,
      models: rows.map((r) => ({
        model: r.model,
        provider: r.provider,
        requests: r.requests,
        errors: r.errors,
        cost: r.cost,
        tokens: Number(r.tokens),
      })),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/budgets',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/budgets',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'Gateway budgets + per-member spend'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ);

    const budgets = await db
      .select()
      .from(gatewayBudgets)
      .where(eq(gatewayBudgets.projectId, projectId));

    const memberRows = await db
      .select({
        userId: gatewayRequestLogs.actorUserId,
        requests: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        tokens: sql<string>`coalesce(sum(${gatewayRequestLogs.inputTokens} + ${gatewayRequestLogs.outputTokens}), 0)`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.projectId, projectId),
          sql`${gatewayRequestLogs.actorUserId} is not null`,
          sql`${gatewayRequestLogs.createdAt} >= date_trunc('month', now())`,
        ),
      )
      .groupBy(gatewayRequestLogs.actorUserId)
      .orderBy(desc(sql`sum(${gatewayRequestLogs.finalCost})`));

    const [projectAgg] = await db
      .select({
        requests: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.projectId, projectId),
          sql`${gatewayRequestLogs.createdAt} >= date_trunc('month', now())`,
        ),
      );

    const emails = await lookupEmailsByUserIds(
      memberRows.map((r) => r.userId).filter((v): v is string => !!v),
    );

    return c.json({
      project_spend: { requests: projectAgg?.requests ?? 0, cost: projectAgg?.cost ?? 0 },
      budgets: budgets.map((b) => ({
        budget_id: b.budgetId,
        scope: b.scope,
        subject_user_id: b.subjectUserId,
        limit_usd: Number(b.limitUsd),
        period: b.period,
        action: b.action,
      })),
      members: memberRows.map((r) => ({
        user_id: r.userId,
        email: r.userId ? (emails.get(r.userId) ?? null) : null,
        requests: r.requests,
        cost: r.cost,
        tokens: Number(r.tokens),
      })),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/gateway/budgets',
    tags: ['gateway'],
    summary: 'PUT /:projectId/gateway/budgets',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              scope: z.enum(['project', 'member']),
              subject_user_id: z.string().nullable().optional(),
              limit_usd: z.number().positive(),
              period: z.enum(['day', 'week', 'month']).optional(),
              action: z.enum(['block', 'warn']).optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(z.any(), 'Budget upserted'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!(await canSetBudget(c, projectId, loaded.row.accountId))) {
      return c.json({ error: 'You do not have permission to set budgets' }, 403);
    }

    const body = await c.req.json();
    const scope = body.scope as 'project' | 'member';
    const subjectUserId = scope === 'member' ? (body.subject_user_id ?? null) : null;
    if (scope === 'member' && !subjectUserId) {
      return c.json({ error: 'subject_user_id is required for a member budget' }, 400);
    }
    const period = (body.period ?? 'month') as 'day' | 'week' | 'month';
    const action = (body.action ?? 'block') as 'block' | 'warn';
    const limit = String(body.limit_usd);

    const existing = await db
      .select({ id: gatewayBudgets.budgetId })
      .from(gatewayBudgets)
      .where(
        and(
          eq(gatewayBudgets.projectId, projectId),
          eq(gatewayBudgets.scope, scope),
          subjectUserId
            ? eq(gatewayBudgets.subjectUserId, subjectUserId)
            : sql`${gatewayBudgets.subjectUserId} is null`,
        ),
      )
      .limit(1);

    if (existing[0]) {
      await db
        .update(gatewayBudgets)
        .set({ limitUsd: limit, period, action, updatedAt: new Date() })
        .where(eq(gatewayBudgets.budgetId, existing[0].id));
    } else {
      await db.insert(gatewayBudgets).values({
        projectId,
        scope,
        subjectUserId,
        limitUsd: limit,
        period,
        action,
        createdBy: c.get('userId'),
      });
    }
    return c.json({ ok: true });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/gateway/budgets/{budgetId}',
    tags: ['gateway'],
    summary: 'DELETE /:projectId/gateway/budgets/:budgetId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), budgetId: z.string().regex(UUID_V4_REGEX) }),
    },
    responses: { 200: json(z.any(), 'Budget removed'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const budgetId = c.req.param('budgetId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!(await canSetBudget(c, projectId, loaded.row.accountId))) {
      return c.json({ error: 'You do not have permission to set budgets' }, 403);
    }
    await db
      .delete(gatewayBudgets)
      .where(and(eq(gatewayBudgets.budgetId, budgetId), eq(gatewayBudgets.projectId, projectId)));
    return c.json({ ok: true });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/errors',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/errors',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ days: z.string().optional() }),
    },
    responses: { 200: json(z.any(), 'Gateway error breakdown'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ);

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    const rows = await db
      .select({
        code: sql<string>`coalesce(${gatewayRequestLogs.errorCode}, 'unknown')`,
        count: sql<number>`count(*)::int`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.projectId, projectId),
          sql`not ${gatewayRequestLogs.ok}`,
          sql`${gatewayRequestLogs.createdAt} >= now() - make_interval(days => ${days})`,
        ),
      )
      .groupBy(gatewayRequestLogs.errorCode)
      .orderBy(desc(sql`count(*)`))
      .limit(12);

    return c.json({ window_days: days, errors: rows });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/keys',
    tags: ['gateway'],
    summary: 'GET /:projectId/gateway/keys',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'Gateway API keys'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!(await canManageKeys(c, projectId, loaded.row.accountId))) {
      return c.json({ error: 'You do not have permission to manage gateway keys' }, 403);
    }
    const keys = await listGatewayKeys(projectId);
    return c.json({
      // Env-correct public host (dev vs prod) so the UI's curl example points at
      // the right gateway instead of a hardcoded one.
      gateway_url: publicGatewayBaseUrl(config.LLM_GATEWAY_BASE_URL),
      keys: keys.map((k) => ({
        key_id: k.keyId,
        name: k.name,
        key_prefix: k.keyPrefix,
        status: k.status,
        last_used_at: k.lastUsedAt,
        created_at: k.createdAt,
      })),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/gateway/keys',
    tags: ['gateway'],
    summary: 'POST /:projectId/gateway/keys',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': { schema: z.object({ name: z.string().min(1).max(255) }) },
        },
      },
    },
    responses: { 200: json(z.any(), 'Gateway API key created'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!(await canManageKeys(c, projectId, loaded.row.accountId))) {
      return c.json({ error: 'You do not have permission to manage gateway keys' }, 403);
    }
    const body = await c.req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'A key name is required' }, 400);
    const created = await createGatewayKey({
      accountId: loaded.row.accountId,
      projectId,
      name,
      createdBy: c.get('userId'),
    });
    return c.json(created);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/gateway/keys/{keyId}',
    tags: ['gateway'],
    summary: 'DELETE /:projectId/gateway/keys/:keyId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), keyId: z.string().regex(UUID_V4_REGEX) }),
    },
    responses: { 200: json(z.any(), 'Gateway API key revoked'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const keyId = c.req.param('keyId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!(await canManageKeys(c, projectId, loaded.row.accountId))) {
      return c.json({ error: 'You do not have permission to manage gateway keys' }, 403);
    }
    const ok = await revokeGatewayKey(projectId, keyId);
    return c.json({ ok });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/gateway/playground',
    tags: ['gateway'],
    summary: 'POST /:projectId/gateway/playground',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              prompt: z.string().min(1).max(8000),
              models: z.array(z.string()).min(1).max(6),
            }),
          },
        },
      },
    },
    responses: { 200: json(z.any(), 'Playground results'), ...errors(400, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,
    );

    const body = await c.req.json();
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const models: string[] = Array.isArray(body.models) ? body.models.slice(0, 6) : [];
    if (!prompt || models.length === 0) {
      return c.json({ error: 'prompt and models are required' }, 400);
    }

    const principal: AuthedPrincipal = {
      userId: c.get('userId'),
      accountId: loaded.row.accountId,
      projectId,
    };
    await assertGatewayBudget(principal);

    const results = await Promise.all(
      models.map(async (model) => {
        const requestId = crypto.randomUUID();
        const request = {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          max_tokens: 512,
        };
        try {
          const candidates = await resolveCandidates(principal, model);
          if (candidates.length === 0) {
            return { model, ok: false, error: 'No upstream configured for this model' };
          }
          const descriptor = candidates[0]!;
          const start = Date.now();
          const res = await callUpstream(request, descriptor);
          const latencyMs = Date.now() - start;
          const data = (await res.json()) as any;
          const usage = data?.usage ?? {};
          const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
          const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
          const cachedTokens = Number(usage.cached_tokens ?? 0) || 0;
          const resolvedModel = String(data?.model ?? descriptor.resolvedModel ?? model);
          const { upstreamCost, finalCost } = calculateCost(
            resolvedModel,
            { promptTokens, completionTokens, cachedTokens },
            descriptor.billingMode === 'none' ? 0 : descriptor.markup,
            typeof usage.cost === 'number' ? usage.cost : undefined,
            descriptor.pricing,
          );
          await persistGatewayTrace({
            requestId,
            startedAt: new Date(start).toISOString(),
            accountId: principal.accountId,
            actorUserId: principal.userId,
            projectId,
            requestedModel: model,
            resolvedModel,
            provider: descriptor.provider,
            billingMode: descriptor.billingMode,
            streaming: false,
            status: res.status,
            ok: res.ok,
            errorMessage: res.ok ? undefined : data?.error?.message ?? data?.message ?? `HTTP ${res.status}`,
            latencyMs,
            attempts: 1,
            candidatesTried: [descriptor.provider],
            usage: { promptTokens, completionTokens, cachedTokens },
            upstreamCost,
            finalCost,
            request,
            response: data,
            metadata: { surface: 'gateway_playground' },
          });
          if (promptTokens + completionTokens > 0) {
            await recordGatewayUsage({
              promptTokens,
              completionTokens,
              cachedTokens,
              accountId: principal.accountId,
              actorUserId: principal.userId,
              projectId,
              provider: descriptor.provider,
              model: resolvedModel,
              upstreamCost,
              finalCost,
              billingMode: descriptor.billingMode,
              streaming: false,
              requestId,
            });
          }
          if (!res.ok) {
            return {
              model,
              ok: false,
              latency_ms: latencyMs,
              error: data?.error?.message ?? data?.message ?? `HTTP ${res.status}`,
            };
          }
          return {
            model,
            ok: true,
            latency_ms: latencyMs,
            output: data?.choices?.[0]?.message?.content ?? '',
            input_tokens: promptTokens,
            output_tokens: completionTokens,
          };
        } catch (err) {
          return { model, ok: false, error: err instanceof Error ? err.message : 'Request failed' };
        }
      }),
    );

    return c.json({ results });
  },
);
