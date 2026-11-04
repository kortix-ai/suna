import { estimateLlmValue, llmValueBasis } from '../../shared/llm-value';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { createRoute, z } from '@hono/zod-openapi';
import { gatewayRequestLogs } from '@kortix/db';
import { db } from '../../shared/db';
import { auth, errors, json, queryText } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { projectReadView } from '../lib/project-read-view';
import { splitLlmSpend } from '../../shared/llm-spend';
import { normalizeString } from '../lib/serializers';
import { classifyGatewayLogReference } from './gateway-log-reference';

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 100;

/** A query value of decimal digits as a number; `fallback` when absent; NaN for anything else. */
function decimalQuery(raw: string | undefined, fallback: number): number {
  const value = normalizeString(raw);
  if (value == null) return fallback;
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

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
  cacheWriteTokens: gatewayRequestLogs.cacheWriteTokens,
  upstreamCost: gatewayRequestLogs.upstreamCost,
  finalCost: gatewayRequestLogs.finalCost,
  streaming: gatewayRequestLogs.streaming,
  billingMode: gatewayRequestLogs.billingMode,
  actorUserId: gatewayRequestLogs.actorUserId,
  keyId: gatewayRequestLogs.keyId,
  sessionId: gatewayRequestLogs.sessionId,
  usageEstimated: sql<boolean>`coalesce(${gatewayRequestLogs.metadata}->>'usageEstimated', 'false') = 'true'`,
};

function serializeLogRow(r: Record<string, any>) {
  // See shared/llm-spend.ts. `final_cost` alone answers "what did Kortix bill
  // you", which is 0 on every BYOK request — it is not what the call cost you.
  const spend = splitLlmSpend({
    billingMode: r.billingMode,
    upstreamCost: r.upstreamCost,
    finalCost: r.finalCost,
  });
  return {
    estimated_usage_value:
      r.ok && !r.usageEstimated && r.metadata?.usageEstimated !== true
        ? estimateLlmValue({
            provider: r.provider,
            model: r.resolvedModel,
            input: r.inputTokens,
            output: r.outputTokens,
            cached: r.cachedTokens,
            cacheWrite: r.cacheWriteTokens,
          })
        : null,
    valuation: llmValueBasis,
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
    cache_write_tokens: r.cacheWriteTokens,
    // What you paid your own provider, and what Kortix debited from your
    // wallet. On a Kortix-managed (`credits`) row `provider_cost` is 0 on
    // purpose: the upstream price there is Kortix's wholesale cost, not
    // yours, and shipping it would publish the Kortix margin on every
    // managed request.
    kortix_cost: spend.kortix_cost,
    provider_cost: spend.provider_cost,
    total_cost: spend.total_cost,
    /** @deprecated Same value as `provider_cost`. */
    upstream_cost: spend.provider_cost,
    /** @deprecated Same value as `kortix_cost`. */
    final_cost: spend.kortix_cost,
    streaming: r.streaming,
    billing_mode: r.billingMode,
    actor_user_id: r.actorUserId,
    key_id: r.keyId,
    session_id: r.sessionId ?? null,
  };
}

export function registerGatewayLogsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/gateway/logs',
      tags: ['gateway'],
      summary: 'List LLM gateway request logs',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({
          limit: queryText(
            `Logs per page, an integer from 1 to ${LIST_LIMIT_MAX}. Default ${LIST_LIMIT_DEFAULT}. Anything else is a 400.`,
          ),
          offset: queryText('Logs to skip: the `next_offset` of the previous page. A non-negative integer; anything else is a 400.'),
          ok: z.enum(['true', 'false']).optional(),
        }),
      },
      responses: { 200: json(z.any(), 'Gateway request logs'), ...errors(400, 404) },
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

      // Out-of-range or non-numeric values answer 400, as on the other project
      // lists. They used to be clamped or replaced in silence (KRTX-3389).
      const limit = decimalQuery(c.req.query('limit'), LIST_LIMIT_DEFAULT);
      if (!(limit >= 1 && limit <= LIST_LIMIT_MAX)) {
        return c.json({ error: `limit must be an integer from 1 to ${LIST_LIMIT_MAX}` }, 400);
      }
      const offset = decimalQuery(c.req.query('offset'), 0);
      if (!Number.isSafeInteger(offset)) return c.json({ error: 'offset must be a non-negative integer' }, 400);
      const okFilter = c.req.query('ok');

      const view = await projectReadView(c, loaded);
      const conds = [eq(gatewayRequestLogs.projectId, projectId)];
      const visible = view.where(gatewayRequestLogs.sessionId, gatewayRequestLogs.actorUserId);
      if (visible) conds.push(visible);
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
      summary: 'Get an LLM gateway request log',
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
      const view = await projectReadView(c, loaded);
      if (!(await view.allows({ sessionId: row.sessionId, createdBy: row.actorUserId }))) {
        return c.json({ error: 'Not found' }, 404);
      }

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
      summary: 'List LLM gateway errors',
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
}
