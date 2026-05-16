import type { Context, Next } from 'hono';
import { auditEvents } from '@kortix/db';
import { db } from './db';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuditEventInput {
  accountId?: string | null;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

function clientIp(c: Context) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || null;
}

function inferResource(path: string) {
  const parts = path.split('/').filter(Boolean);
  const v1Index = parts.indexOf('v1');
  const root = v1Index >= 0 ? parts[v1Index + 1] : parts[0];
  const id = v1Index >= 0 ? parts[v1Index + 2] : parts[1];

  if (!root) return { resourceType: 'unknown', resourceId: null };
  if (root === 'p') return { resourceType: 'sandbox_proxy', resourceId: id ?? null };
  if (root === 'account-invites') return { resourceType: 'account_invite', resourceId: id ?? null };
  return {
    resourceType: root.replace(/-/g, '_').replace(/s$/, ''),
    resourceId: id && !id.includes(':') ? id : null,
  };
}

function inferAccountId(c: Context) {
  const parts = c.req.path.split('/').filter(Boolean);
  const accountPathId = parts[0] === 'v1' && parts[1] === 'accounts' ? parts[2] : null;
  return ((c as any).get('accountId') as string | undefined)
    || c.req.query('account_id')
    || c.req.query('accountId')
    || accountPathId
    || null;
}

export async function recordAuditEvent(input: AuditEventInput) {
  await db.insert(auditEvents).values({
    accountId: input.accountId || null,
    actorUserId: input.actorUserId || null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId || null,
    before: input.before ?? null,
    after: input.after ?? null,
    ip: input.ip || null,
    userAgent: input.userAgent || null,
    metadata: input.metadata ?? {},
  });
}

export async function auditStateChangingRequest(c: Context, next: Next) {
  await next();

  if (!STATE_CHANGING_METHODS.has(c.req.method)) return;
  if (c.res.status < 200 || c.res.status >= 400) return;
  if (!c.req.path.startsWith('/v1/')) return;

  const inferred = inferResource(c.req.path);
  const actorUserId = ((c as any).get('userId') as string | undefined) ?? null;
  const accountId = inferAccountId(c);
  if (!actorUserId && !accountId) return;

  recordAuditEvent({
    accountId,
    actorUserId,
    action: `${c.req.method} ${c.req.path}`,
    resourceType: inferred.resourceType,
    resourceId: inferred.resourceId,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') || null,
    metadata: {
      status: c.res.status,
    },
  }).catch((error) => {
    console.error('[audit] Failed to record audit event:', error);
  });
}
