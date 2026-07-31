import type { Context, Next } from 'hono';
import { auditEvents } from '@kortix/db';
import { getRequestContext } from '../lib/request-context';
import { db } from './db';
import { dispatchAuditEvent } from './audit-webhooks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIPPED_PATHS = new Set(['/v1/health', '/v1/openapi.json', '/v1/docs']);

export type AuditActorType = 'human' | 'agent' | 'service_account' | 'system';
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'pending';

export interface AuditEventInput {
  accountId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  actorType?: AuditActorType | null;
  source?: string | null;
  outcome?: AuditOutcome | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  httpStatus?: number | null;
  durationMs?: number | null;
  requestId?: string | null;
  traceId?: string | null;
  correlationId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

function clientIp(c: Context): string | null {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null
  );
}

function pathIds(path: string): { projectId: string | null; sessionId: string | null } {
  const projectMatch = path.match(/\/projects\/([^/]+)/);
  const sessionMatch = path.match(/\/projects\/[^/]+\/sessions\/([^/]+)/);
  const projectId = projectMatch?.[1] && UUID_RE.test(projectMatch[1]) ? projectMatch[1] : null;
  return {
    projectId,
    sessionId: sessionMatch?.[1] ?? null,
  };
}

function inferResource(path: string): { resourceType: string; resourceId: string | null } {
  const ids = pathIds(path);
  if (ids.sessionId) return { resourceType: 'project_session', resourceId: ids.sessionId };
  if (ids.projectId) return { resourceType: 'project', resourceId: ids.projectId };

  const parts = path.split('/').filter(Boolean);
  const v1Index = parts.indexOf('v1');
  const root = v1Index >= 0 ? parts[v1Index + 1] : parts[0];
  const id = v1Index >= 0 ? parts[v1Index + 2] : parts[1];

  if (!root) return { resourceType: 'unknown', resourceId: null };
  if (root === 'p') return { resourceType: 'sandbox_proxy', resourceId: id ?? null };
  if (root === 'account-invites') {
    return { resourceType: 'account_invite', resourceId: id ?? null };
  }
  return {
    resourceType: root.replace(/-/g, '_').replace(/s$/, ''),
    resourceId: id && !id.includes(':') ? id : null,
  };
}

function inferAccountId(c: Context): string | null {
  const parts = c.req.path.split('/').filter(Boolean);
  const accountPathCandidate =
    parts[0] === 'v1' && parts[1] === 'accounts' ? parts[2] : null;
  const accountPathId =
    accountPathCandidate && UUID_RE.test(accountPathCandidate) ? accountPathCandidate : null;
  return (
    ((c as any).get('accountId') as string | undefined) ||
    getRequestContext()?.accountId ||
    c.req.query('account_id') ||
    c.req.query('accountId') ||
    accountPathId ||
    null
  );
}

function projectSessionId(c: Context, pathSessionId: string | null): string | null {
  if (pathSessionId) return pathSessionId;
  const authType = (c as any).get('authType') as string | undefined;
  if (authType === 'supabase') return null;
  return ((c as any).get('sessionId') as string | undefined) ?? null;
}

function inferActorType(c: Context, actorUserId: string | null): AuditActorType | null {
  const authType = (c as any).get('authType') as string | undefined;
  if (authType === 'service_account') return 'service_account';
  const hasAgentGrant = (c as any).get('agentGrant') != null;
  const apiKeyType = (c as any).get('apiKeyType') as string | undefined;
  const hasProjectSession =
    authType !== 'supabase' && ((c as any).get('sessionId') != null || hasAgentGrant);
  if (hasProjectSession || (authType === 'apiKey' && apiKeyType === 'sandbox')) return 'agent';
  if (actorUserId) return 'human';
  return inferAccountId(c) ? 'system' : null;
}

export function inferAuditSource(c: Context, actorType: AuditActorType | null): string {
  if (actorType === 'service_account') return 'automation';
  if (actorType === 'agent') return 'agent';
  if ((c as any).get('authType') === 'supabase') return 'web';
  return 'api';
}

function outcomeForStatus(status: number): AuditOutcome {
  if (status === 202) return 'pending';
  if (status === 401 || status === 403) return 'denied';
  if (status >= 200 && status < 400) return 'success';
  return 'failure';
}

function errorStatus(error: unknown): number {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return 500;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  const request = getRequestContext();
  const [row] = await db
    .insert(auditEvents)
    .values({
      accountId: uuidOrNull(input.accountId || request?.accountId),
      projectId: uuidOrNull(input.projectId || request?.projectId),
      sessionId: input.sessionId || request?.sessionId || null,
      actorUserId: uuidOrNull(input.actorUserId),
      actorType: input.actorType ?? (input.actorUserId ? 'human' : 'system'),
      source: input.source ?? 'api',
      outcome: input.outcome ?? 'success',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId || null,
      httpStatus: input.httpStatus ?? null,
      durationMs: input.durationMs ?? null,
      requestId: input.requestId || request?.requestId || null,
      traceId: input.traceId || request?.traceId || null,
      correlationId: input.correlationId || null,
      before: input.before ?? null,
      after: input.after ?? null,
      ip: input.ip || null,
      userAgent: input.userAgent || null,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (row && row.accountId) {
    dispatchAuditEvent({
      schema_version: 1,
      event: {
        event_id: row.eventId,
        occurred_at: row.occurredAt.toISOString(),
        account_id: row.accountId,
        project_id: row.projectId,
        session_id: row.sessionId,
        actor_user_id: row.actorUserId,
        actor_type: row.actorType,
        source: row.source,
        outcome: row.outcome,
        action: row.action,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        http_status: row.httpStatus,
        duration_ms: row.durationMs,
        request_id: row.requestId,
        trace_id: row.traceId,
        correlation_id: row.correlationId,
        before: row.before,
        after: row.after,
        ip: row.ip,
        user_agent: row.userAgent,
        metadata: row.metadata ?? {},
      },
    });
  }
}

export async function auditApiRequest(c: Context, next: Next): Promise<void> {
  if (c.req.method === 'OPTIONS' || SKIPPED_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const startedAt = Date.now();
  let thrown: unknown;
  try {
    await next();
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    const request = getRequestContext();
    const actorUserId =
      ((c as any).get('userId') as string | undefined) ?? request?.userId ?? null;
    const accountId = inferAccountId(c);
    if (actorUserId || accountId) {
      const status = thrown ? errorStatus(thrown) : c.res.status;
      const inferred = inferResource(c.req.path);
      const ids = pathIds(c.req.path);
      const actorType = inferActorType(c, actorUserId);
      try {
        await recordAuditEvent({
          accountId,
          projectId: ids.projectId ?? request?.projectId ?? null,
          sessionId: projectSessionId(c, ids.sessionId ?? request?.sessionId ?? null),
          actorUserId,
          actorType,
          source: inferAuditSource(c, actorType),
          outcome: outcomeForStatus(status),
          action: `${c.req.method} ${c.req.path}`,
          resourceType: inferred.resourceType,
          resourceId: inferred.resourceId,
          httpStatus: status,
          durationMs: Date.now() - startedAt,
          requestId: request?.requestId ?? null,
          traceId: request?.traceId ?? null,
          correlationId:
            c.req.header('x-correlation-id') || c.req.header('idempotency-key') || null,
          ip: clientIp(c),
          userAgent: c.req.header('user-agent') || null,
          metadata: {
            method: c.req.method,
            path: c.req.path,
          },
        });
      } catch (error) {
        console.error('[audit] Failed to record API request:', error);
      }
    }
  }
}

export const auditStateChangingRequest = auditApiRequest;
