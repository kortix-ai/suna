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

import { Context, Hono } from 'hono';
import { and, asc, desc, eq, gte, like, lt, or, type SQL } from 'drizzle-orm';
import { auditEvents, auditWebhooks } from '@kortix/db';
import { db } from '../shared/db';
import { generateWebhookSecret } from '../shared/audit-webhooks';
import { recordAuditEvent } from '../shared/audit';
import type { AppEnv } from '../types';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import { assertAuthorized } from '../iam/dispatcher';

export const auditRouter = new Hono<AppEnv>();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// Shared filter builder used by both the list endpoint (cursor pagination)
// and the export endpoint (no cursor). Keeping one source of truth means
// what you see in the viewer is exactly what export gives you.
function buildFilters(
  accountId: string,
  actionPrefix: string | null,
  sinceRaw: string | null,
): SQL[] {
  const conditions: SQL[] = [eq(auditEvents.accountId, accountId)];

  if (actionPrefix) {
    conditions.push(
      actionPrefix.includes('.') && !actionPrefix.endsWith('.')
        ? or(
            eq(auditEvents.action, actionPrefix),
            like(auditEvents.action, `${actionPrefix}.%`),
          )!
        : like(auditEvents.action, `${actionPrefix}%`),
    );
  }

  if (sinceRaw) {
    const since = new Date(sinceRaw);
    if (!Number.isNaN(since.getTime())) {
      conditions.push(gte(auditEvents.occurredAt, since));
    }
  }
  return conditions;
}

// GET /v1/accounts/:accountId/audit
//   ?action=iam.       — prefix match on action (e.g. "iam.policy.")
//   ?since=ISO         — only events at or after this timestamp
//   ?cursor=ISO|uuid   — keyset pagination cursor (occurredAt|eventId)
//   ?limit=N           — default 50, max 200
auditRouter.get('/:accountId/audit', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);

  const actionPrefix = c.req.query('action')?.trim() || null;
  const sinceRaw = c.req.query('since')?.trim() || null;
  const cursor = c.req.query('cursor')?.trim() || null;
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const conditions = buildFilters(accountId, actionPrefix, sinceRaw);

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
  const nextCursor =
    hasMore && last ? `${last.occurredAt.toISOString()}|${last.eventId}` : null;

  return c.json({
    events: page.map((r) => ({
      event_id: r.eventId,
      occurred_at: r.occurredAt.toISOString(),
      actor_user_id: r.actorUserId,
      action: r.action,
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      before: r.before,
      after: r.after,
      ip: r.ip,
      user_agent: r.userAgent,
      metadata: r.metadata,
    })),
    next_cursor: nextCursor,
  });
});

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
  'actor_user_id',
  'resource_type',
  'resource_id',
  'ip',
  'user_agent',
  'before',
  'after',
  'metadata',
];

auditRouter.get('/:accountId/audit/export', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);

  const format = (c.req.query('format') || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'jsonl') {
    return c.json({ error: 'format must be csv or jsonl' }, 400);
  }

  const actionPrefix = c.req.query('action')?.trim() || null;
  const sinceRaw = c.req.query('since')?.trim() || null;

  const conditions = buildFilters(accountId, actionPrefix, sinceRaw);

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
          action: r.action,
          actor_user_id: r.actorUserId,
          resource_type: r.resourceType,
          resource_id: r.resourceId,
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
        csvEscape(r.actorUserId),
        csvEscape(r.resourceType),
        csvEscape(r.resourceId),
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
});

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

auditRouter.get('/:accountId/audit/webhooks', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const rows = await db
    .select()
    .from(auditWebhooks)
    .where(eq(auditWebhooks.accountId, accountId))
    .orderBy(desc(auditWebhooks.createdAt));
  return c.json({ webhooks: rows.map((r) => serializeWebhook(r)) });
});

auditRouter.post('/:accountId/audit/webhooks', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

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

  const actionPrefix =
    typeof body.action_prefix === 'string' && body.action_prefix.trim()
      ? body.action_prefix.trim()
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
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      null,
    userAgent: c.req.header('user-agent') || null,
  });

  // Reveal the secret EXACTLY ONCE so the admin can paste it into their
  // verification code. Subsequent GETs never include it.
  return c.json(serializeWebhook(row, true), 201);
});

auditRouter.patch('/:accountId/audit/webhooks/:webhookId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const webhookId = c.req.param('webhookId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const [before] = await db
    .select()
    .from(auditWebhooks)
    .where(
      and(eq(auditWebhooks.webhookId, webhookId), eq(auditWebhooks.accountId, accountId)),
    )
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
  if (body.action_prefix !== undefined) {
    const raw = body.action_prefix;
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
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      null,
    userAgent: c.req.header('user-agent') || null,
  });

  return c.json(serializeWebhook(updated));
});

auditRouter.delete('/:accountId/audit/webhooks/:webhookId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const webhookId = c.req.param('webhookId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const rows = await db
    .delete(auditWebhooks)
    .where(
      and(eq(auditWebhooks.webhookId, webhookId), eq(auditWebhooks.accountId, accountId)),
    )
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
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      null,
    userAgent: c.req.header('user-agent') || null,
  });

  return c.json({ deleted: true });
});
