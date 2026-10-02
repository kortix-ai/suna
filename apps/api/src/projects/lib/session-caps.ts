
import { projectSessions } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';





import { config } from '../../config';
import { consumeProjectSessionCreateBudget } from '../../shared/rate-limit';
import { RATE_LIMIT_EXCEEDED_ACTION } from '../../shared/rate-limit-audit';













import { resolveAccountSessionLimit } from '../../shared/account-limits';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
















import { ACTIVE_SESSION_STATUSES, PROVISIONING_SESSION_STATUSES, type RequestAuditContext } from './serializers';



















import type { SessionCreateError } from './session-create';
export async function countActiveProjectSessions(accountId: string): Promise<number> {
  const [row] = await db
    .select({ activeCount: sql<number>`count(*)::int` })
    .from(projectSessions)
    .where(
      and(
      eq(projectSessions.accountId, accountId),
      inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  return Number(row?.activeCount ?? 0);
}
export async function countActiveSessionsInProject(projectId: string): Promise<number> {
  const [row] = await db
    .select({ activeCount: sql<number>`count(*)::int` })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  return Number(row?.activeCount ?? 0);
}

/**
 * Hard per-PROJECT ceiling on active sessions, independent of account tier.
 *
 * INCIDENT 2026-08-21: a per-minute trigger in one project spawned a fresh
 * session every tick and never cleaned up — 104 active sandboxes in one
 * project, 183 in another. The account-level concurrent-session limit never
 * fired because those accounts were entitled to be big; no single PROJECT has
 * a legitimate reason to hold 100+ live sandboxes, and each one multiplies
 * every env fan-out and provider call the project makes. Deliberately generous
 * so no real team ever sees it; it exists to clip runaway automation.
 */
export function projectActiveSessionLimit(): number {
  const configured = Number((config as any).KORTIX_PROJECT_ACTIVE_SESSION_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 100;
}

export async function countProvisioningProjectSessions(projectId: string): Promise<number> {
  const [row] = await db
    .select({ provisioningCount: sql<number>`count(*)::int` })
    .from(projectSessions)
    .where(
      and(
      eq(projectSessions.projectId, projectId),
      inArray(projectSessions.status, [...PROVISIONING_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  return Number(row?.provisioningCount ?? 0);
}

/**
 * @param reserveSlots How many concurrent-session slots this create must LEAVE
 *   FREE. `0` (the default) is the ordinary cap: a create may take the last
 *   slot. `1` is speculative creation — a pre-created session is real, booted,
 *   billed compute holding a slot exactly like a working session, so it must
 *   never take the LAST one and 429 the next genuine session start. On Starter
 *   (`concurrentSessionLimit: 3`, billing/services/tiers.ts) three project page
 *   views with zero real work were enough.
 */
export async function enforceConcurrentSessionCap(
  accountId: string,
  userId: string,
  request?: RequestAuditContext,
  reserveSlots = 0,
): Promise<SessionCreateError | null> {
  const { tier, limit, source } = await resolveAccountSessionLimit(accountId);
  const activeSessions = await countActiveProjectSessions(accountId);
  if (activeSessions < limit - reserveSlots) return null;

  recordAuditEvent({
    accountId,
    actorUserId: userId,
    action: RATE_LIMIT_EXCEEDED_ACTION,
    resourceType: 'project_session',
    resourceId: accountId,
    ip: request?.ip ?? null,
    userAgent: request?.userAgent ?? null,
    metadata: {
      limiter: 'concurrent_sessions',
      tier,
      limit,
      limit_source: source,
      active_sessions: activeSessions,
      reserve_slots: reserveSlots,
    },
  }).catch((error) => {
    console.error('[projects] Failed to record session cap audit event:', error);
  });

  const message = `You've reached your plan's concurrent-session limit (${limit}). Upgrade your plan for a higher limit, or contact the Kortix team to raise it for your account.`;
  return {
    status: 429,
    headers: {
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
    },
    body: {
      error: message,
      message,
      code: 'concurrent_session_limit',
      limit,
      active_sessions: activeSessions,
      reserve_slots: reserveSlots,
    },
  };
}

export async function checkConcurrentSessionCap(
  accountId: string,
  userId: string,
  request?: RequestAuditContext,
  reserveSlots = 0,
  projectId?: string,
): Promise<{
  error?: SessionCreateError;
  headers: Record<string, string>;
}> {
  // Three independent reads. They ran one after another on every create.
  const [{ limit }, activeSessions, activeInProject] = await Promise.all([
    resolveAccountSessionLimit(accountId),
    countActiveProjectSessions(accountId),
    projectId ? countActiveSessionsInProject(projectId) : Promise.resolve(0),
  ]);
  const remainingAfterCreate = Math.max(limit - activeSessions - 1, 0);
  const headers = {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remainingAfterCreate),
  };

  // The per-project ceilings run before the account-tier check: they are the
  // more specific refusals, and an account big enough to pass the tier check
  // is exactly the account whose runaway project these exist to clip.
  if (projectId) {
    const projectLimit = projectActiveSessionLimit();
    if (activeInProject >= projectLimit) {
      recordAuditEvent({
        accountId,
        actorUserId: userId,
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'project_session',
        resourceId: projectId,
        ip: request?.ip ?? null,
        userAgent: request?.userAgent ?? null,
        metadata: {
          limiter: 'project_active_sessions',
          limit: projectLimit,
          active_sessions_in_project: activeInProject,
        },
      }).catch((error) => {
        console.error('[projects] Failed to record project session cap audit event:', error);
      });
      const message = `This project already has ${activeInProject} active sessions (limit ${projectLimit}). Stop or delete finished sessions before starting more — a trigger or automation that never cleans up its sessions is usually what hits this.`;
      return {
        headers: {
          'X-RateLimit-Limit': String(projectLimit),
          'X-RateLimit-Remaining': '0',
        },
        error: {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(projectLimit),
            'X-RateLimit-Remaining': '0',
          },
          body: {
            error: message,
            message,
            code: 'project_session_limit',
            limit: projectLimit,
            active_sessions: activeInProject,
          },
        },
      };
    }
  }

  // The hourly create budget runs AFTER the active-session cap and only
  // charges REAL creates (reserveSlots === 0). Two genuine-user protections
  // live in that ordering: a speculative warm pre-create is page-view-driven
  // and must not drain the budget, and a user retrying against the cap must
  // not burn budget on refusals — otherwise they clean up their sessions and
  // find themselves locked out for the rest of the hour anyway.
  if (projectId && reserveSlots === 0) {
    const budget = consumeProjectSessionCreateBudget(projectId);
    if (!budget.allowed) {
      recordAuditEvent({
        accountId,
        actorUserId: userId,
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'project_session',
        resourceId: projectId,
        ip: request?.ip ?? null,
        userAgent: request?.userAgent ?? null,
        metadata: {
          limiter: 'project_session_creates',
          limit: budget.limit,
          retry_after_ms: budget.retryAfterMs ?? null,
        },
      }).catch((error) => {
        console.error('[projects] Failed to record session create budget audit event:', error);
      });
      const message = `This project has hit its hourly session-create limit (${budget.limit}/hour). A trigger or automation creating a session on every tick is usually what hits this — reuse sessions instead of spawning new ones.`;
      return {
        headers: {
          'X-RateLimit-Limit': String(budget.limit),
          'X-RateLimit-Remaining': '0',
        },
        error: {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(budget.limit),
            'X-RateLimit-Remaining': '0',
          },
          body: {
            error: message,
            message,
            code: 'project_session_create_limit',
            limit: budget.limit,
            retry_after_seconds: Math.ceil((budget.retryAfterMs ?? budget.resetMs) / 1000),
          },
        },
      };
    }
  }

  if (activeSessions < limit - reserveSlots) return { headers };

  const error = await enforceConcurrentSessionCap(accountId, userId, request, reserveSlots);
  return {
    headers: error?.headers ?? headers,
    ...(error ? { error } : {}),
  };
}
