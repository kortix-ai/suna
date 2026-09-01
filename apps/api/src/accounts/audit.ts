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
import { auditEvents, auditWebhookDeliveries, auditWebhooks } from '@kortix/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../iam';
import { actorOf } from '../iam/actor';
import { assertAllowedSourceAddress } from '../shared/allowed-source-address';
import { ErrorSchema, auth, errors, json, makeOpenApiApp } from '../openapi';
import { flushAuditEvents, recordAuditEvent } from '../shared/audit';
import {
  deliverTestEvent,
  generateWebhookSecret,
  replayAuditWebhookDelivery,
} from '../shared/audit-webhooks';
import { db } from '../shared/db';
import {
  buildAuditCursorCondition,
  parseAuditCursor,
  parseAuditInstant,
  parseAuditLimit,
  serializeAuditEvent,
} from '../shared/audit-query';
import { AuditListSchema } from '../shared/audit-schema';
import { reconcileAuditEvents } from '../shared/audit-reconciliation';
import type { AppEnv } from '../types';
import { type AuditFilterInput, buildFilters } from './audit-filters';
import { requireEntitlement } from './iam/helpers';

export const auditRouter = makeOpenApiApp<AppEnv>();

const AccountIdParam = z.object({ accountId: z.string().uuid() });
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
        phase: z.string().optional(),
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
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.AUDIT_READ);
    const denied = await requireEntitlement(c, accountId, 'auditAccess');
    if (denied) return denied;
    const actionPrefix = c.req.query('action')?.trim() || null;
    const actor = c.req.query('actor')?.trim() || null;
    const actorType = c.req.query('actor_type')?.trim() || null;
    const projectId = c.req.query('project_id')?.trim() || null;
    const sessionId = c.req.query('session_id')?.trim() || null;
    const source = c.req.query('source')?.trim() || null;
    const phase = c.req.query('phase')?.trim() || null;
    const outcome = c.req.query('outcome')?.trim() || null;
    const requestId = c.req.query('request_id')?.trim() || null;
    const correlationId = c.req.query('correlation_id')?.trim() || null;
    const resourceType = c.req.query('resource_type')?.trim() || null;
    const sinceRaw = c.req.query('since')?.trim() || null;
    const untilRaw = c.req.query('until')?.trim() || null;
    const q = c.req.query('q')?.trim() || null;
    let parsedCursor: ReturnType<typeof parseAuditCursor>;
    let limit: number;
    try {
      parseAuditInstant(sinceRaw, 'since');
      parseAuditInstant(untilRaw, 'until');
      parsedCursor = parseAuditCursor(c.req.query('cursor')?.trim() || null);
      limit = parseAuditLimit(c.req.query('limit')?.trim() || null, DEFAULT_LIMIT, MAX_LIMIT);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    // Flush the snapshot emitted before this read. Traffic that arrives after
    // this barrier stays asynchronous and cannot delay the request indefinitely.
    await flushAuditEvents();

    const conditions = buildFilters(accountId, {
      actor,
      actorType,
      projectId,
      sessionId,
      source,
      phase,
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
    if (parsedCursor) {
      conditions.push(buildAuditCursorCondition(parsedCursor, accountId, 'descending'));
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
      events: page.map(serializeAuditEvent),
      next_cursor: nextCursor,
    });
  },
);

// ─── Export ───────────────────────────────────────────────────────────────
// Streams an audit slice as CSV or JSONL. Same filter shape as the list
// endpoint. Each page is capped at EXPORT_MAX rows. Continue with the cursor
// in X-Audit-Next-Cursor until X-Audit-Complete is true.

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
  'account_id',
  'project_id',
  'session_id',
  'opencode_session_id',
  'turn_id',
  'message_id',
  'tool_call_id',
  'execution_id',
  'session_sequence',
  'actor_user_id',
  'actor_type',
  'agent_id',
  'agent_name',
  'initiator_actor_type',
  'initiator_actor_id',
  'parent_event_id',
  'delegation_depth',
  'source',
  'authoritative_source',
  'client_reported_source',
  'outcome',
  'action',
  'phase',
  'resource_type',
  'resource_id',
  'http_status',
  'duration_ms',
  'request_id',
  'trace_id',
  'correlation_id',
  'causation_id',
  'source_ledger',
  'source_record_id',
  'source_revision',
  'input_summary',
  'output_summary',
  'input_sha256',
  'output_sha256',
  'error_code',
  'error_message',
  'integrity_previous_hash',
  'integrity_hash',
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
        phase: z.string().optional(),
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
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.AUDIT_READ);
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
    const phase = c.req.query('phase')?.trim() || null;
    const outcome = c.req.query('outcome')?.trim() || null;
    const requestId = c.req.query('request_id')?.trim() || null;
    const correlationId = c.req.query('correlation_id')?.trim() || null;
    const resourceType = c.req.query('resource_type')?.trim() || null;
    const sinceRaw = c.req.query('since')?.trim() || null;
    const untilRaw = c.req.query('until')?.trim() || null;
    const q = c.req.query('q')?.trim() || null;
    let parsedCursor: ReturnType<typeof parseAuditCursor>;
    let exportLimit: number;
    try {
      parseAuditInstant(sinceRaw, 'since');
      parseAuditInstant(untilRaw, 'until');
      parsedCursor = parseAuditCursor(c.req.query('cursor')?.trim() || null);
      exportLimit = parseAuditLimit(c.req.query('limit')?.trim() || null, EXPORT_MAX, EXPORT_MAX);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    await flushAuditEvents();

    const conditions = buildFilters(accountId, {
      actor,
      actorType,
      projectId,
      sessionId,
      source,
      phase,
      outcome,
      requestId,
      correlationId,
      actionPrefix,
      resourceType,
      sinceRaw,
      untilRaw,
      q,
    });

    if (parsedCursor) {
      conditions.push(buildAuditCursorCondition(parsedCursor, accountId, 'ascending'));
    }

    const fetched = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      // Export is chronological (oldest → newest) — that's the order humans
      // expect when grepping through a CSV; pagination uses reverse order.
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.eventId))
      .limit(exportLimit + 1);
    const hasMore = fetched.length > exportLimit;
    const rows = hasMore ? fetched.slice(0, exportLimit) : fetched;
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? `${last.occurredAt.toISOString()}|${last.eventId}` : null;

    const filenameDate = new Date().toISOString().slice(0, 10);
    const filename = `audit-${filenameDate}.${format}`;

    if (format === 'jsonl') {
      const body = rows.map((r) => JSON.stringify(serializeAuditEvent(r))).join('\n');
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Audit-Row-Count': String(rows.length),
          'X-Audit-Capped': hasMore ? 'true' : 'false',
          'X-Audit-Complete': hasMore ? 'false' : 'true',
          'X-Audit-Next-Cursor': nextCursor ?? '',
        },
      });
    }

    // CSV
    const lines: string[] = [CSV_HEADERS.join(',')];
    for (const r of rows) {
      const event = serializeAuditEvent(r);
      lines.push(
        CSV_HEADERS.map((header) => csvEscape(event[header as keyof typeof event])).join(','),
      );
    }
    return new Response(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Audit-Row-Count': String(rows.length),
        'X-Audit-Capped': hasMore ? 'true' : 'false',
        'X-Audit-Complete': hasMore ? 'false' : 'true',
        'X-Audit-Next-Cursor': nextCursor ?? '',
      },
    });
  },
);

auditRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/audit/reconcile',
    tags: ['accounts'],
    summary: 'Reconcile durable source ledgers into the canonical audit log',
    ...auth,
    request: {
      params: AccountIdParam,
      query: z.object({ limit: z.string().optional() }),
    },
    responses: { 200: json(z.any(), 'Reconciliation page'), ...errors(400, 401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    const denied = await requireEntitlement(c, accountId, 'auditAccess');
    if (denied) return denied;
    let limit: number;
    try {
      limit = parseAuditLimit(c.req.query('limit')?.trim() || null, 1_000, 5_000);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    await flushAuditEvents();
    const result = await reconcileAuditEvents(accountId, limit);
    await recordAuditEvent({
      accountId,
      actorUserId: userId,
      authoritativeSource: 'human',
      action: 'iam.audit.reconcile',
      resourceType: 'audit_ledger',
      outputSummary: { ...result },
    });
    return c.json(result);
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
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
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
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
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
    // delivery immediately on create, so the same guard used for connector
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
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
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
    method: 'get',
    path: '/{accountId}/audit/webhooks/{webhookId}/deliveries',
    tags: ['accounts'],
    summary: 'List durable audit webhook deliveries',
    ...auth,
    request: {
      params: z.object({ accountId: z.string().uuid(), webhookId: z.string().uuid() }),
      query: z.object({ status: z.string().optional(), limit: z.string().optional() }),
    },
    responses: {
      200: json(z.object({ deliveries: z.array(z.any()) }), 'Webhook deliveries'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const webhookId = c.req.param('webhookId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    let limit: number;
    try {
      limit = parseAuditLimit(c.req.query('limit')?.trim() || null, 100, 500);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    await flushAuditEvents();
    const [hook] = await db
      .select({ webhookId: auditWebhooks.webhookId })
      .from(auditWebhooks)
      .where(and(eq(auditWebhooks.accountId, accountId), eq(auditWebhooks.webhookId, webhookId)))
      .limit(1);
    if (!hook) return c.json({ error: 'webhook not found' }, 404);
    const status = c.req.query('status')?.trim() || null;
    const rows = await db
      .select()
      .from(auditWebhookDeliveries)
      .where(
        and(
          eq(auditWebhookDeliveries.webhookId, webhookId),
          ...(status ? [eq(auditWebhookDeliveries.status, status)] : []),
        ),
      )
      .orderBy(desc(auditWebhookDeliveries.createdAt))
      .limit(limit);
    return c.json({
      deliveries: rows.map((row) => ({
        delivery_id: row.deliveryId,
        webhook_id: row.webhookId,
        event_id: row.eventId,
        status: row.status,
        attempts: row.attempts,
        next_attempt_at: row.nextAttemptAt.toISOString(),
        last_status: row.lastStatus,
        last_error: row.lastError,
        delivered_at: row.deliveredAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      })),
    });
  },
);

auditRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/audit/webhooks/{webhookId}/deliveries/{deliveryId}/replay',
    tags: ['accounts'],
    summary: 'Replay a durable audit webhook delivery',
    ...auth,
    request: {
      params: z.object({
        accountId: z.string().uuid(),
        webhookId: z.string().uuid(),
        deliveryId: z.string().uuid(),
      }),
    },
    responses: {
      200: json(z.object({ replayed: z.boolean() }), 'Delivery queued'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const webhookId = c.req.param('webhookId');
    const deliveryId = c.req.param('deliveryId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    const [hook] = await db
      .select({ webhookId: auditWebhooks.webhookId })
      .from(auditWebhooks)
      .where(and(eq(auditWebhooks.accountId, accountId), eq(auditWebhooks.webhookId, webhookId)))
      .limit(1);
    if (!hook) return c.json({ error: 'webhook not found' }, 404);
    const replayed = await replayAuditWebhookDelivery(deliveryId, webhookId);
    if (!replayed) return c.json({ error: 'delivery not found' }, 404);
    await recordAuditEvent({
      accountId,
      actorUserId: userId,
      authoritativeSource: 'human',
      action: 'iam.audit.webhook.delivery.replay',
      resourceType: 'audit_webhook_delivery',
      resourceId: deliveryId,
      metadata: { webhook_id: webhookId },
    });
    return c.json({ replayed: true });
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
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
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
