import { estimateLlmValue, llmValueBasis } from '../../shared/llm-value';
import { type SQL, and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { createRoute, z } from '@hono/zod-openapi';
import { gatewayRequestLogs, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { auth, errors, json, queryText } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { projectReadView } from '../lib/project-read-view';
import { splitLlmSpend } from '../../shared/llm-spend';
import { normalizeString } from '../lib/serializers';
import { sessionTitleFromMetadata } from '../lib/session-title-placeholder';
import { classifyGatewayLogReference } from './gateway-log-reference';
import { workspaceIdParam } from '../../shared/route-params';

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 100;
const FACET_HOURS_DEFAULT = 24;
/** A week: the facet read scans every request of the window. */
const FACET_HOURS_MAX = 168;
/** Values per facet, the most-used first. */
const FACET_VALUES_MAX = 50;

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
  // The session message the call came from (`x-kortix-message-id` and friends,
  // packages/llm-gateway request-origin.ts). Null on rows written before kortixd sent them.
  messageId: sql<string | null>`${gatewayRequestLogs.metadata}->>'messageId'`,
  turnId: sql<string | null>`${gatewayRequestLogs.metadata}->>'turnId'`,
  threadId: sql<string | null>`${gatewayRequestLogs.metadata}->>'threadId'`,
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
    message_id: r.messageId ?? r.metadata?.messageId ?? null,
    turn_id: r.turnId ?? r.metadata?.turnId ?? null,
    thread_id: r.threadId ?? r.metadata?.threadId ?? null,
  };
}

/** Titles of the sessions a page of logs names, in one read. A deleted session has none. */
async function sessionTitles(projectId: string, sessionIds: (string | null | undefined)[]) {
  const ids = [...new Set(sessionIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map<string, string | null>();
  const rows = await db
    .select({ sessionId: projectSessions.sessionId, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), inArray(projectSessions.sessionId, ids)));
  return new Map(rows.map((row) => [row.sessionId, sessionTitleFromMetadata(row.metadata)]));
}

/** `%` and `_` match themselves in an ILIKE pattern. */
const likeEscape = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** An ISO-8601 time as a Date; null when absent; `invalid` for anything else. */
function timeQuery(raw: string | undefined): Date | null | 'invalid' {
  const value = normalizeString(raw);
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'invalid' : date;
}

const FILTER_QUERY = {
  ok: z.enum(['true', 'false']).optional(),
  session_id: queryText('Only requests of this session.'),
  model: queryText('Only requests that asked for or ran on this model id.'),
  provider: queryText('Only requests served by this provider.'),
  error_code: queryText('Only failed requests with this error code.'),
  q: queryText(
    'Search: a model, provider or error code containing the text, or a request, session or message id equal to it.',
  ),
  since: queryText('Only requests at or after this ISO-8601 time.'),
  until: queryText('Only requests at or before this ISO-8601 time.'),
};

/**
 * The list filters as SQL, or the 400 message for a bad one. Every filter is
 * applied in the database, so a filter reaches every request, not only the
 * page the client has loaded.
 */
function logFilters(query: (name: string) => string | undefined): { conds: SQL[] } | { error: string } {
  const conds: SQL[] = [];
  const ok = query('ok');
  if (ok === 'true') conds.push(eq(gatewayRequestLogs.ok, true));
  if (ok === 'false') conds.push(eq(gatewayRequestLogs.ok, false));
  const sessionId = normalizeString(query('session_id'));
  if (sessionId) conds.push(eq(gatewayRequestLogs.sessionId, sessionId));
  const model = normalizeString(query('model'));
  if (model) conds.push(or(eq(gatewayRequestLogs.requestedModel, model), eq(gatewayRequestLogs.resolvedModel, model))!);
  const provider = normalizeString(query('provider'));
  if (provider) conds.push(eq(gatewayRequestLogs.provider, provider));
  const errorCode = normalizeString(query('error_code'));
  if (errorCode) conds.push(eq(gatewayRequestLogs.errorCode, errorCode));
  const since = timeQuery(query('since'));
  const until = timeQuery(query('until'));
  if (since === 'invalid' || until === 'invalid') return { error: 'since and until must be ISO-8601 times' };
  if (since) conds.push(gte(gatewayRequestLogs.createdAt, since));
  if (until) conds.push(lte(gatewayRequestLogs.createdAt, until));
  const q = normalizeString(query('q'));
  if (q) {
    if (q.length > 200) return { error: 'q must be at most 200 characters' };
    const like = `%${likeEscape(q)}%`;
    conds.push(
      or(
        sql`${gatewayRequestLogs.requestedModel} ilike ${like}`,
        sql`${gatewayRequestLogs.resolvedModel} ilike ${like}`,
        sql`${gatewayRequestLogs.provider} ilike ${like}`,
        sql`coalesce(${gatewayRequestLogs.errorCode}, '') ilike ${like}`,
        eq(gatewayRequestLogs.requestId, q),
        eq(gatewayRequestLogs.sessionId, q),
        sql`${gatewayRequestLogs.metadata}->>'messageId' = ${q}`,
        sql`${gatewayRequestLogs.metadata}->>'turnId' = ${q}`,
      )!,
    );
  }
  return { conds };
}

export function registerGatewayLogsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/gateway/logs',
      tags: ['gateway'],
      summary: 'List LLM gateway request logs',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
          limit: queryText(
            `Logs per page, an integer from 1 to ${LIST_LIMIT_MAX}. Default ${LIST_LIMIT_DEFAULT}. Anything else is a 400.`,
          ),
          offset: queryText('Logs to skip: the `next_offset` of the previous page. A non-negative integer; anything else is a 400.'),
          ...FILTER_QUERY,
        }),
      },
      responses: { 200: json(z.any(), 'Gateway request logs'), ...errors(400, 404) },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
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
      const filters = logFilters((name) => c.req.query(name));
      if ('error' in filters) return c.json({ error: filters.error }, 400);

      const view = await projectReadView(c, loaded);
      const conds = [eq(gatewayRequestLogs.projectId, projectId), ...filters.conds];
      const visible = view.where(gatewayRequestLogs.sessionId, gatewayRequestLogs.actorUserId);
      if (visible) conds.push(visible);

      const rows = await db
        .select(LIST_COLUMNS)
        .from(gatewayRequestLogs)
        .where(and(...conds))
        .orderBy(desc(gatewayRequestLogs.createdAt))
        .limit(limit + 1)
        .offset(offset);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const titles = await sessionTitles(projectId, page.map((row) => row.sessionId));
      return c.json({
        logs: page.map((row) => ({
          ...serializeLogRow(row),
          session_title: row.sessionId ? (titles.get(row.sessionId) ?? null) : null,
        })),
        next_offset: hasMore ? offset + limit : null,
      });
    },
  );

  // Before `/logs/{logId}`: call order is dispatch order, and `facets` is not a log id.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/gateway/logs/facets',
      tags: ['gateway'],
      summary: 'List the values the gateway log filters can take',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
          hours: queryText(`The window, an integer from 1 to ${FACET_HOURS_MAX} hours. Default ${FACET_HOURS_DEFAULT}.`),
        }),
      },
      responses: { 200: json(z.any(), 'Gateway log filter values with request counts'), ...errors(400, 404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ,
      );
      const hours = decimalQuery(c.req.query('hours'), FACET_HOURS_DEFAULT);
      if (!(hours >= 1 && hours <= FACET_HOURS_MAX)) {
        return c.json({ error: `hours must be an integer from 1 to ${FACET_HOURS_MAX}` }, 400);
      }

      const view = await projectReadView(c, loaded);
      const visible = view.where(gatewayRequestLogs.sessionId, gatewayRequestLogs.actorUserId);
      const model = sql`coalesce(nullif(${gatewayRequestLogs.requestedModel}, ''), nullif(${gatewayRequestLogs.resolvedModel}, ''))`;
      // One scan of the window, four groupings. `idx_gateway_logs_project_time`
      // bounds it to the project and the window.
      const rows = await db.execute<{
        model: string | null;
        provider: string | null;
        error_code: string | null;
        session_id: string | null;
        g_model: number;
        g_provider: number;
        g_error: number;
        count: number;
        cost: string;
      }>(sql`
        select ${model} as model,
               nullif(${gatewayRequestLogs.provider}, '') as provider,
               ${gatewayRequestLogs.errorCode} as error_code,
               ${gatewayRequestLogs.sessionId} as session_id,
               grouping(${model}) as g_model,
               grouping(nullif(${gatewayRequestLogs.provider}, '')) as g_provider,
               grouping(${gatewayRequestLogs.errorCode}) as g_error,
               count(*)::int as count,
               coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::text as cost
          from ${gatewayRequestLogs}
         where ${gatewayRequestLogs.projectId} = ${projectId}
           and ${gatewayRequestLogs.createdAt} >= now() - make_interval(hours => ${hours})
           ${visible ? sql`and ${visible}` : sql``}
         group by grouping sets ((${model}), (nullif(${gatewayRequestLogs.provider}, '')), (${gatewayRequestLogs.errorCode}), (${gatewayRequestLogs.sessionId}))
      `);
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: typeof rows }).rows ?? []);
      const top = <T,>(items: T[], count: (item: T) => number) =>
        items.sort((a, b) => count(b) - count(a)).slice(0, FACET_VALUES_MAX);
      // `grouping()` is 0 for the column a row is grouped by.
      const values = (pick: (row: (typeof list)[number]) => string | null, grouped: (row: (typeof list)[number]) => boolean) =>
        top(
          list.filter((row) => grouped(row) && pick(row)).map((row) => ({ value: pick(row)!, count: Number(row.count) })),
          (item) => item.count,
        );
      const sessionRows = top(
        list.filter((row) => row.g_model === 1 && row.g_provider === 1 && row.g_error === 1 && row.session_id),
        (row) => Number(row.count),
      );
      const titles = await sessionTitles(projectId, sessionRows.map((row) => row.session_id));
      return c.json({
        window_hours: hours,
        models: values((row) => row.model, (row) => row.g_model === 0),
        providers: values((row) => row.provider, (row) => row.g_provider === 0),
        error_codes: values((row) => row.error_code, (row) => row.g_error === 0),
        sessions: sessionRows.map((row) => ({
          session_id: row.session_id!,
          title: titles.get(row.session_id!) ?? null,
          count: Number(row.count),
        })),
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/gateway/logs/{logId}',
      tags: ['gateway'],
      summary: 'Get an LLM gateway request log',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), logId: z.string() }) },
      responses: { 200: json(z.any(), 'Gateway request log detail'), ...errors(400, 404) },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
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

      const titles = await sessionTitles(projectId, [row.sessionId]);
      return c.json({
        ...serializeLogRow(row),
        session_title: row.sessionId ? (titles.get(row.sessionId) ?? null) : null,
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
      path: '/{workspaceId}/gateway/errors',
      tags: ['gateway'],
      summary: 'List LLM gateway errors',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({ days: z.string().optional() }),
      },
      responses: { 200: json(z.any(), 'Gateway error breakdown'), ...errors(404) },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
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
