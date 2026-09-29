import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { gatewayRequestLogs } from '@kortix/db';
import { db } from '../../shared/db';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { classifyGatewayLogReference } from './gateway-log-reference';
import {
  LIST_COLUMNS,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  serializeLogRow,
} from './gateway-log-projection';

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
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ,
    );

    const limit = Math.min(
      Math.max(Number(c.req.query('limit')) || LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
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
    return c.json({
      logs: page.map(serializeLogRow),
      next_offset: hasMore ? offset + limit : null,
    });
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
    const logReference = c.req.param('logId');
    const referenceKind = classifyGatewayLogReference(logReference);
    if (referenceKind === 'invalid') {
      return c.json({ error: 'Invalid log id or request id' }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ,
    );

    const [row] = await db
      .select()
      .from(gatewayRequestLogs)
      .where(
        and(
          referenceKind === 'both'
            ? or(
                eq(gatewayRequestLogs.logId, logReference),
                eq(gatewayRequestLogs.requestId, logReference),
              )
            : eq(gatewayRequestLogs.requestId, logReference),
          eq(gatewayRequestLogs.projectId, projectId),
        ),
      )
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
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ,
    );

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
