// Audit log read surface — backed by the existing kortix.audit_events table
// the global middleware + IAM mutation helpers write to.
//
// Reads (gated on audit.read):
//   - GET    /:accountId/audit                  cursor-paginated list
//   - GET    /:accountId/audit/export?format=   CSV or JSONL streaming export
//
// Webhook management (gated on account.write):
//   - GET    /:accountId/audit/webhooks
//   - POST   /:accountId/audit/webhooks
//   - PATCH  /:accountId/audit/webhooks/:id
//   - DELETE /:accountId/audit/webhooks/:id

import { createRoute, z } from '@hono/zod-openapi';
import { auditEvents, auditWebhooks } from '@kortix/db';
import { and, asc, desc, eq, lt, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../iam';
import { assertAllowedSourceAddress } from '../marketplace/catalog';
import { ErrorSchema, auth, errors, json, makeOpenApiApp } from '../openapi';
import { recordAuditEvent } from '../shared/audit';
import { deliverTestEvent, generateWebhookSecret } from '../shared/audit-webhooks';
import { db } from '../shared/db';
import type { AppEnv } from '../types';
import { type AuditFilterInput, buildFilters } from './audit-filters';
import { requireEntitlement } from './iam/helpers';

export const auditRouter = makeOpenApiApp<AppEnv>();

const AccountIdParam = z.object({ accountId: z.string() });
const AuditEventSchema = z
  .object({
    event_id: z.string(),
    occurred_at: z.string(),
    project_id: z.string().nullable(),
    session_id: z.string().nullable(),
    actor_user_id: z.string().nullable(),
    actor_type: z.enum(['human', 'agent', 'service_account', 'system']).nullable(),
    source: z.string().nullable(),
    outcome: z.enum(['success', 'failure', 'denied', 'pending']).nullable(),
    action: z.string(),
    resource_type: z.string().nullable(),
    resource_id: z.string().nullable(),
    http_status: z.number().nullable(),
    duration_ms: z.number().nullable(),
    request_id: z.string().nullable(),
    trace_id: z.string().nullable(),
    correlation_id: z.string().nullable(),
    before: z.any().nullable(),
    after: z.any().nullable(),
    ip: z.string().nullable(),
    user_agent: z.string().nullable(),
    metadata: z.any().nullable(),
  })
  .openapi('AuditEvent');
const AuditListSchema = z
  .object({ events: z.array(AuditEventSchema), next_cursor: z.string().nullable() })
  .openapi('AuditEventList');
const AuditWebhookSchema = z
  .object({
    webhook_id: z.string(),
    name: z.string(),
    url: z.string(),
    enabled: z.boolean(),
    action_prefix: z.string().nullable(),
    last_delivered_at: z.string().nullable(),
    last_error_at: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    secret: z.string().optional(),
    // Present only on the create response: the outcome of the one-shot test
    // delivery, so the UI can warn on a bad URL instead of silent failure.
    test: z
      .object({ ok: z.boolean(), status: z.number().optional(), error: z.string().optional() })
      .optional(),
  })
  .openapi('AuditWebhook');
const AuditWebhookListSchema = z
  .object({ webhooks: z.array(AuditWebhookSchema) })
  .openapi('AuditWebhookList');
const AuditWebhookInputSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    action_prefix: z.string().optional(),
    actionPrefix: z.string().optional(),
  })
  .openapi('AuditWebhookCreate');
const AuditWebhookPatchSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    action_prefix: z.string().nullable().optional(),
    actionPrefix: z.string().nullable().optional(),
  })
  .openapi('AuditWebhookPatch');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// Re-exported from ./audit-filters (pure, unit-tested) so existing importers
// keep working.
export { buildFilters, type AuditFilterInput } from './audit-filters';

// GET /v1/accounts/:accountId/audit
//   ?action=connector.       — prefix match on action
//   ?actor=<uuid>           — only events performed by this user
//   ?actor_type=agent       — human, agent, service_account, or system
//   ?project_id=<uuid>      — one project
//   ?session_id=<id>        — one session
//   ?source=cli             — one client or execution source
//   ?outcome=failure        — success, failure, denied, or pending
//   ?request_id=<id>        — one API request
//   ?correlation_id=<id>    — one cross-system operation
//   ?resource_type=X        — prefix match on resource_type
//   ?since=ISO              — only events at or after this timestamp
//   ?until=ISO              — only events at or before this timestamp
//   ?q=text                 — search action, resource, project, session, request,
//                             trace, and correlation identifiers
//   ?cursor=ISO|uuid        — keyset pagination cursor (occurredAt|eventId)
//   ?limit=N                — default 50, max 200
auditRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/audit',
    tags: ['accounts'],
    summary: 'List audit events (cursor-paginated)',
    ...auth,
    request: {
      params: AccountIdParam,
      query: z.object({
        action: z.string().optional(),
        actor: z.string().uuid().optional(),
        actor_type: z.enum(['human', 'agent', 'service_account', 'system']).optional(),
        project_id: z.string().uuid().optional(),
        session_id: z.string().optional(),
        source: z.string().optional(),
        outcome: z.enum(['success', 'failure', 'denied', 'pending']).optional(),
        request_id: z.string().optional(),
        correlation_id: z.string().optional(),
        resource_type: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        q: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: json(AuditListSchema, 'Audit events page'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);
    const denied = await requireEntitlement(c, accountId, 'auditAccess');
    if (denied) return denied;

    const actionPrefix = c.req.query('action')?.trim() || null;
    const actor = c.req.query('actor')?.trim() || null;
    const actorType = c.req.query('actor_type')?.trim() || null;
    const projectId = c.req.query('project_id')?.trim() || null;
    const sessionId = c.req.query('session_id')?.trim() || null;
    const source = c.req.query('source')?.trim() || null;
    const outcome = c.req.query('outcome')?.trim() || null;
    const requestId = c.req.query('request_id')?.trim() || null;
    const correlationId = c.req.query('correlation_id')?.trim() || null;
    const resourceType = c.req.query('resource_type')?.trim() || null;
    const sinceRaw = c.req.query('since')?.trim() || null;
    const untilRaw = c.req.query('until')?.trim() || null;
    const q = c.req.query('q')?.trim() || null;
    const cursor = c.req.query('cursor')?.trim() || null;
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const conditions = buildFilters(accountId, {
      actor,
      actorType,
      projectId,
      sessionId,
      source,
      outcome,
      requestId,
      correlationId,
      actionPrefix,
      resourceType,
      sinceRaw,
      untilRaw,
      q,
    });

    // Keyset cursor encoded as "<isoTimestamp>|<eventId>" so equal timestamps
    // tie-break by event id (stable order). Cheaper than OFFSET on long lists.
    if (cursor) {
      const [tsStr, lastId] = cursor.split('|');
      const ts = new Date(tsStr);
      if (!Number.isNaN(ts.getTime()) && lastId) {
        conditions.push(
          or(
            lt(auditEvents.occurredAt, ts),
            and(eq(auditEvents.occurredAt, ts), lt(auditEvents.eventId, lastId)),
          )!,
        );
      }
    }

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.eventId))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? `${last.occurredAt.toISOString()}|${last.eventId}` : null;

    return c.json({
      events: page.map((r) => ({
        event_id: r.eventId,
        occurred_at: r.occurredAt.toISOString(),
        project_id: r.projectId,
        session_id: r.sessionId,
        actor_user_id: r.actorUserId,
        actor_type: r.actorType,
        source: r.source,
        outcome: r.outcome,
        action: r.action,
        resource_type: r.resourceType,
        resource_id: r.resourceId,
        http_status: r.httpStatus,
        duration_ms: r.durationMs,
        request_id: r.requestId,
        trace_id: r.traceId,
        correlation_id: r.correlationId,
        before: r.before,
        after: r.after,
        ip: r.ip,
        user_agent: r.userAgent,
        metadata: r.metadata,
      })),
      next_cursor: nextCursor,
    });
  },
);

// ─── Export ───────────────────────────────────────────────────────────────
// Streams an audit slice as CSV or JSONL. Same filter shape as the list
// endpoint. Hard-capped at EXPORT_MAX rows per request — for larger pulls
// callers should page via repeated `since=` calls.

const EXPORT_MAX = 10_000;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  // Quote any field that contains a delimiter, quote, or newline. Quoting
  // rule: wrap in quotes and double internal quotes (RFC 4180).
  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_HEADERS = [
  'event_id',
  'occurred_at',
  'action',
  'project_id',
  'session_id',
  'actor_user_id',
  'actor_type',
  'source',
  'outcome',
  'resource_type',
  'resource_id',
  'http_status',
  'duration_ms',
  'request_id',
  'trace_id',
  'correlation_id',
  'ip',
  'user_agent',
  'before',
  'after',
  'metadata',
];

auditRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/audit/export',
    tags: ['accounts'],
    summary: 'Export audit events as CSV or JSONL',
    ...auth,
    request: {
      params: AccountIdParam,
      query: z.object({
        format: z.enum(['csv', 'jsonl']).optional(),
        action: z.string().optional(),
        actor: z.string().uuid().optional(),
        actor_type: z.enum(['human', 'agent', 'service_account', 'system']).optional(),
        project_id: z.string().uuid().optional(),
        session_id: z.string().optional(),
        source: z.string().optional(),
        outcome: z.enum(['success', 'failure', 'denied', 'pending']).optional(),
        request_id: z.string().optional(),
        correlation_id: z.string().optional(),
        resource_type: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        q: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Audit export stream',
        content: {
          'text/csv': { schema: z.string() },
          'application/x-ndjson': { schema: z.string() },
        },
      },
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);
    const denied = await requireEntitlement(c, accountId, 'auditAccess');
    if (denied) return denied;

    const format = (c.req.query('format') || 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'jsonl') {
      return c.json({ error: 'format must be csv or jsonl' }, 400);
    }

    const actionPrefix = c.req.query('action')?.trim() || null;
    const actor = c.req.query('actor')?.trim() || null;
    const actorType = c.req.query('actor_type')?.trim() || null;
    const projectId = c.req.query('project_id')?.trim() || null;
    const sessionId = c.req.query('session_id')?.trim() || null;
    const source = c.req.query('source')?.trim() || null;
    const outcome = c.req.query('outcome')?.trim() || null;
    const requestId = c.req.query('request_id')?.trim() || null;
    const correlationId = c.req.query('correlation_id')?.trim() || null;
    const resourceType = c.req.query('resource_type')?.trim() || null;
    const sinceRaw = c.req.query('since')?.trim() || null;
    const untilRaw = c.req.query('until')?.trim() || null;
    const q = c.req.query('q')?.trim() || null;

    const conditions = buildFilters(accountId, {
      actor,
      actorType,
      projectId,
      sessionId,
      source,
      outcome,
      requestId,
      correlationId,
      actionPrefix,
      resourceType,
      sinceRaw,
      untilRaw,
      q,
    });

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      // Export is chronological (oldest → newest) — that's the order humans
      // expect when grepping through a CSV; pagination uses reverse order.
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.eventId))
      .limit(EXPORT_MAX);

    const filenameDate = new Date().toISOString().slice(0, 10);
    const filename = `audit-${filenameDate}.${format}`;

    if (format === 'jsonl') {
      const body = rows
        .map((r) =>
          JSON.stringify({
            event_id: r.eventId,
            occurred_at: r.occurredAt.toISOString(),
            project_id: r.projectId,
            session_id: r.sessionId,
            action: r.action,
            actor_user_id: r.actorUserId,
            actor_type: r.actorType,
            source: r.source,
            outcome: r.outcome,
            resource_type: r.resourceType,
            resource_id: r.resourceId,
            http_status: r.httpStatus,
            duration_ms: r.durationMs,
            request_id: r.requestId,
            trace_id: r.traceId,
            correlation_id: r.correlationId,
            ip: r.ip,
            user_agent: r.userAgent,
            before: r.before,
            after: r.after,
            metadata: r.metadata,
          }),
        )
        .join('\n');
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Audit-Row-Count': String(rows.length),
          'X-Audit-Capped': rows.length >= EXPORT_MAX ? 'true' : 'false',
        },
      });
    }

    // CSV
    const lines: string[] = [CSV_HEADERS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.eventId),
          csvEscape(r.occurredAt.toISOString()),
          csvEscape(r.action),
          csvEscape(r.projectId),
          csvEscape(r.sessionId),
          csvEscape(r.actorUserId),
          csvEscape(r.actorType),
          csvEscape(r.source),
          csvEscape(r.outcome),
          csvEscape(r.resourceType),
          csvEscape(r.resourceId),
          csvEscape(r.httpStatus),
          csvEscape(r.durationMs),
          csvEscape(r.requestId),
          csvEscape(r.traceId),
          csvEscape(r.correlationId),
          csvEscape(r.ip),
          csvEscape(r.userAgent),
          csvEscape(r.before),
          csvEscape(r.after),
          csvEscape(r.metadata),
        ].join(','),
      );
    }
    return new Response(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Audit-Row-Count': String(rows.length),
        'X-Audit-Capped': rows.length >= EXPORT_MAX ? 'true' : 'false',
      },
    });
  },
);

// ─── Webhooks ─────────────────────────────────────────────────────────────
// Per-account HTTP destinations the audit pipeline POSTs to. Managed
// under account.write (same gate as other account-admin secrets). Secret
// is shown ONCE at create — never returned in subsequent reads.

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

function serializeWebhook(w: typeof auditWebhooks.$inferSelect, includeSecret = false) {
  return {
    webhook_id: w.webhookId,
    name: w.name,
    url: w.url,
    enabled: w.enabled,
    action_prefix: w.actionPrefix,
    last_delivered_at: w.lastDeliveredAt?.toISOString() ?? null,
    last_error_at: w.lastErrorAt?.toISOString() ?? null,
    last_error: w.lastError,
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
    // Only on create: include the plaintext signing secret. After that
    // it lives only on the row (server-side use) and never returns over
    // the API.
    ...(includeSecret ? { secret: w.secret } : {}),
  };
}

auditRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/audit/webhooks',
    tags: ['accounts'],
    summary: 'List audit webhooks',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(AuditWebhookListSchema, 'Audit webhooks'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    // No entitlement gate on listing: a downgraded admin must be able to see
    // leftover webhooks to delete them. Creation/update stay gated below.

    const rows = await db
      .select()
      .from(auditWebhooks)
      .where(eq(auditWebhooks.accountId, accountId))
      .orderBy(desc(auditWebhooks.createdAt));
    return c.json({ webhooks: rows.map((r) => serializeWebhook(r)) });
  },
);

auditRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/audit/webhooks',
    tags: ['accounts'],
    summary: 'Create an audit webhook',
    ...auth,
    request: {
      params: AccountIdParam,
      body: { content: { 'application/json': { schema: AuditWebhookInputSchema } } },
    },
    responses: {
      201: json(AuditWebhookSchema, 'Created webhook (secret shown once)'),
      400: json(ErrorSchema, 'Bad request'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    const denied = await requireEntitlement(c, accountId, 'auditAccess');
    if (denied) return denied;

    const body = await readBody(c);

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (name.length > 128) return c.json({ error: 'name too long (max 128 chars)' }, 400);

    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) return c.json({ error: 'url is required' }, 400);
    // Cheap sanity guard. Real reachability is verified at delivery time;
    // here we just refuse blatantly-broken inputs.
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return c.json({ error: 'url must be http(s)' }, 400);
      }
    } catch {
      return c.json({ error: 'url is not a valid URL' }, 400);
    }
    // SSRF guard: reject private/link-local/internal targets (e.g. cloud
    // metadata at 169.254.169.254). This endpoint fires a server-side test
    // delivery immediately on create, so the same guard used for marketplace
    // source URLs applies here.
    try {
      assertAllowedSourceAddress(url);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const actionPrefix =
      typeof body.action_prefix === 'string' && body.action_prefix.trim()
        ? body.action_prefix.trim()
        : typeof body.actionPrefix === 'string' && body.actionPrefix.trim()
          ? body.actionPrefix.trim()
          : null;

    const secret = generateWebhookSecret();

    const [row] = await db
      .insert(auditWebhooks)
      .values({
        accountId,
        url,
        secret,
        name,
        actionPrefix,
        enabled: true,
        createdBy: userId,
      })
      .returning();

    // Audit the webhook config itself — meta-auditing.
    await recordAuditEvent({
      accountId,
      actorUserId: userId,
      action: 'iam.audit.webhook.create',
      resourceType: 'audit_webhook',
      resourceId: row.webhookId,
      after: { name: row.name, url: row.url, action_prefix: row.actionPrefix },
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null,
      userAgent: c.req.header('user-agent') || null,
    });

    // Fire a one-shot test delivery so a mistyped/unreachable URL surfaces at
    // creation time — not 30 minutes into a demo staring at an empty SIEM. The
    // webhook is created regardless (a transient outage shouldn't block setup);
    // the outcome rides back on the response so the UI can warn. Stamps
    // last_error / last_delivered_at on the row just like a real delivery.
    const test = await deliverTestEvent(row);

    // Reveal the secret EXACTLY ONCE so the admin can paste it into their
    // verification code. Subsequent GETs never include it.
    return c.json({ ...serializeWebhook(row, true), test }, 201);
  },
);

auditRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/audit/webhooks/{webhookId}',
    tags: ['accounts'],
    summary: 'Update an audit webhook',
    ...auth,
    request: {
      params: z.object({ accountId: z.string(), webhookId: z.string() }),
      body: { content: { 'application/json': { schema: AuditWebhookPatchSchema } } },
    },
    responses: {
      200: json(AuditWebhookSchema, 'Updated webhook'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const webhookId = c.req.param('webhookId');
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    const denied = await requireEntitlement(c, accountId, 'auditAccess');
    if (denied) return denied;

    const [before] = await db
      .select()
      .from(auditWebhooks)
      .where(and(eq(auditWebhooks.webhookId, webhookId), eq(auditWebhooks.accountId, accountId)))
      .limit(1);
    if (!before) return c.json({ error: 'webhook not found' }, 404);

    const body = await readBody(c);
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (typeof body.name === 'string') {
      const next = body.name.trim();
      if (!next || next.length > 128) return c.json({ error: 'invalid name' }, 400);
      updates.name = next;
    }
    if (typeof body.enabled === 'boolean') {
      updates.enabled = body.enabled;
    }
    if (body.action_prefix !== undefined || body.actionPrefix !== undefined) {
      const raw = body.action_prefix ?? body.actionPrefix;
      updates.actionPrefix = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    }
    // url is intentionally NOT editable here — the integration on the other
    // side is keyed by URL + secret, and rotating either should be a
    // delete + create operation so audit captures both events distinctly.

    const [updated] = await db
      .update(auditWebhooks)
      .set(updates)
      .where(eq(auditWebhooks.webhookId, webhookId))
      .returning();

    await recordAuditEvent({
      accountId,
      actorUserId: userId,
      action: 'iam.audit.webhook.update',
      resourceType: 'audit_webhook',
      resourceId: webhookId,
      before: { name: before.name, enabled: before.enabled, action_prefix: before.actionPrefix },
      after: { name: updated.name, enabled: updated.enabled, action_prefix: updated.actionPrefix },
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null,
      userAgent: c.req.header('user-agent') || null,
    });

    return c.json(serializeWebhook(updated));
  },
);

auditRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/audit/webhooks/{webhookId}',
    tags: ['accounts'],
    summary: 'Delete an audit webhook',
    ...auth,
    request: {
      params: z.object({ accountId: z.string(), webhookId: z.string() }),
    },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deleted'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const webhookId = c.req.param('webhookId');
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    // No entitlement gate: deleting a webhook is cleanup, always allowed — and
    // delivery itself is entitlement-gated in shared/audit-webhooks.ts, so a
    // leftover row on a downgraded account streams nothing either way.

    const rows = await db
      .delete(auditWebhooks)
      .where(and(eq(auditWebhooks.webhookId, webhookId), eq(auditWebhooks.accountId, accountId)))
      .returning({ name: auditWebhooks.name, url: auditWebhooks.url });
    if (rows.length === 0) return c.json({ error: 'webhook not found' }, 404);

    await recordAuditEvent({
      accountId,
      actorUserId: userId,
      action: 'iam.audit.webhook.delete',
      resourceType: 'audit_webhook',
      resourceId: webhookId,
      before: { name: rows[0]!.name, url: rows[0]!.url },
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null,
      userAgent: c.req.header('user-agent') || null,
    });

    return c.json({ deleted: true });
  },
);
