// Audit log read surface — backed by the existing kortix.audit_events table
// the global middleware + IAM mutation helpers write to. Single endpoint,
// cursor-paginated, with prefix filtering on action.

import { Hono } from 'hono';
import { and, desc, eq, gte, like, lt, or } from 'drizzle-orm';
import { auditEvents } from '@kortix/db';
import { db } from '../shared/db';
import type { AppEnv } from '../types';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../iam';

export const auditRouter = new Hono<AppEnv>();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

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

  const conditions = [eq(auditEvents.accountId, accountId)];

  if (actionPrefix) {
    // Allow exact match if the caller passes a full action string, otherwise
    // treat the input as a prefix ("iam.policy" → "iam.policy.%").
    conditions.push(
      actionPrefix.includes('.') && !actionPrefix.endsWith('.')
        ? or(eq(auditEvents.action, actionPrefix), like(auditEvents.action, `${actionPrefix}.%`))!
        : like(auditEvents.action, `${actionPrefix}%`),
    );
  }

  if (sinceRaw) {
    const since = new Date(sinceRaw);
    if (!Number.isNaN(since.getTime())) {
      conditions.push(gte(auditEvents.occurredAt, since));
    }
  }

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
