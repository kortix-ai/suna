import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { gatewayBudgets, gatewayRequestLogs } from '@kortix/db';
import { db } from '../../shared/db';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser, lookupEmailsByUserIds } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  kortixBilledSpendSql,
  providerBilledSpendSql,
  totalSpendSql,
} from '../../shared/llm-spend';
import { listProjectGatewaySessionSpend } from '../../shared/session-costs';
import { canDo } from './gateway-shared';

const canSetBudget = (c: any, projectId: string, accountId: string) =>
  canDo(c, projectId, accountId, PROJECT_ACTIONS.PROJECT_GATEWAY_BUDGET_SET);

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
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,
    );

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    const [agg] = await db
      .select({
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ok)::int`,
        totalCost: totalSpendSql,
        kortixCost: kortixBilledSpendSql,
        providerCost: providerBilledSpendSql,
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
      kortix_cost: agg?.kortixCost ?? 0,
      provider_cost: agg?.providerCost ?? 0,
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
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,
    );

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    const rows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${gatewayRequestLogs.createdAt}), 'YYYY-MM-DD')`,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
        cost: totalSpendSql,
        kortixCost: kortixBilledSpendSql,
        providerCost: providerBilledSpendSql,
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
      kortix_cost: number;
      provider_cost: number;
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
        kortix_cost: r?.kortixCost ?? 0,
        provider_cost: r?.providerCost ?? 0,
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
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,
    );

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    return c.json(
      await listProjectGatewaySessionSpend({
        accountId: loaded.row.accountId,
        projectId,
        days,
      }),
    );
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
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,
    );

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    const rows = await db
      .select({
        model: gatewayRequestLogs.requestedModel,
        provider: gatewayRequestLogs.provider,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
        cost: totalSpendSql,
        kortixCost: kortixBilledSpendSql,
        providerCost: providerBilledSpendSql,
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
        kortix_cost: r.kortixCost,
        provider_cost: r.providerCost,
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
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,
    );

    const budgets = await db
      .select()
      .from(gatewayBudgets)
      .where(eq(gatewayBudgets.projectId, projectId));

    const memberRows = await db
      .select({
        userId: gatewayRequestLogs.actorUserId,
        requests: sql<number>`count(*)::int`,
        // Budgets cap what a project SPENDS, so per-member spend here is the
        // same total-spend figure the budget gate enforces on — not the
        // Kortix-billed slice, which is 0 on every BYOK request.
        cost: totalSpendSql,
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
      .orderBy(desc(totalSpendSql));

    const [projectAgg] = await db
      .select({
        requests: sql<number>`count(*)::int`,
        cost: totalSpendSql,
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
      params: z.object({ projectId: z.string(), budgetId: z.string().uuid() }),
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
