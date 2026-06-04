// IAM V2 routes: account session policy, active-session listing +
// force-logout, and PAT (Personal Access Token) lifecycle policy.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { and, eq, sql } from 'drizzle-orm';
import { accounts, accountSessionActivity } from '@kortix/db';
import { db } from '../../shared/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { iamRouter, AccountIdParam } from './app';
import { auditIam, readBody, HttpError } from './helpers';

// ─── Session policy ───────────────────────────────────────────────────────
// Per-account ceilings on session age + idle gap. Null on either field
// means "no limit". 0 < value ≤ 10080 (one week).

const SESSION_LIMIT_MINUTES = 10080; // 7 days

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/session-policy',
    tags: ['iam'],
    summary: 'Get the account session policy',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ max_lifetime_minutes: z.number().nullable(), idle_timeout_minutes: z.number().nullable() }), 'Session policy'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({
      maxLifetimeMinutes: accounts.sessionMaxLifetimeMinutes,
      idleTimeoutMinutes: accounts.sessionIdleTimeoutMinutes,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);

  return c.json({
    max_lifetime_minutes: row.maxLifetimeMinutes,
    idle_timeout_minutes: row.idleTimeoutMinutes,
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/session-policy',
    tags: ['iam'],
    summary: 'Update the account session policy',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ max_lifetime_minutes: z.number().nullable(), maxLifetimeMinutes: z.number().nullable(), idle_timeout_minutes: z.number().nullable(), idleTimeoutMinutes: z.number().nullable() }).partial() } } } },
    responses: {
      200: json(z.object({ max_lifetime_minutes: z.number().nullable(), idle_timeout_minutes: z.number().nullable() }), 'Updated session policy'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  // Accept null → clear, undefined → leave untouched, number → set.
  function parseLimit(key: string, value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new HttpError(400, `${key} must be a positive integer or null`);
    }
    if (value > SESSION_LIMIT_MINUTES) {
      throw new HttpError(
        400,
        `${key} cannot exceed ${SESSION_LIMIT_MINUTES} minutes (7 days)`,
      );
    }
    return value;
  }

  let maxLifetimeMinutes: number | null | undefined;
  let idleTimeoutMinutes: number | null | undefined;
  try {
    maxLifetimeMinutes = parseLimit(
      'max_lifetime_minutes',
      body.max_lifetime_minutes ?? body.maxLifetimeMinutes,
    );
    idleTimeoutMinutes = parseLimit(
      'idle_timeout_minutes',
      body.idle_timeout_minutes ?? body.idleTimeoutMinutes,
    );
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const [before] = await db
    .select({
      maxLifetimeMinutes: accounts.sessionMaxLifetimeMinutes,
      idleTimeoutMinutes: accounts.sessionIdleTimeoutMinutes,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (maxLifetimeMinutes !== undefined) updates.sessionMaxLifetimeMinutes = maxLifetimeMinutes;
  if (idleTimeoutMinutes !== undefined) updates.sessionIdleTimeoutMinutes = idleTimeoutMinutes;

  await db
    .update(accounts)
    .set(updates)
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: 'iam.session_policy.update',
    resourceType: 'account',
    resourceId: accountId,
    before: {
      max_lifetime_minutes: before.maxLifetimeMinutes,
      idle_timeout_minutes: before.idleTimeoutMinutes,
    },
    after: {
      max_lifetime_minutes:
        maxLifetimeMinutes !== undefined ? maxLifetimeMinutes : before.maxLifetimeMinutes,
      idle_timeout_minutes:
        idleTimeoutMinutes !== undefined ? idleTimeoutMinutes : before.idleTimeoutMinutes,
    },
  });

  return c.json({
    max_lifetime_minutes:
      maxLifetimeMinutes !== undefined ? maxLifetimeMinutes : before.maxLifetimeMinutes,
    idle_timeout_minutes:
      idleTimeoutMinutes !== undefined ? idleTimeoutMinutes : before.idleTimeoutMinutes,
  });
  },
);

// ─── Active sessions + force-logout ───────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/sessions',
    tags: ['iam'],
    summary: 'List recent account sessions',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ sessions: z.array(z.object({ user_id: z.string(), session_id: z.string(), first_seen_at: z.string(), last_seen_at: z.string(), revoked_at: z.string().nullable(), revoked_reason: z.string().nullable(), ip: z.string().nullable(), user_agent: z.string().nullable() })) }), 'Recent sessions'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);

  const rows = await db
    .select({
      userId: accountSessionActivity.userId,
      sessionId: accountSessionActivity.sessionId,
      firstSeenAt: accountSessionActivity.firstSeenAt,
      lastSeenAt: accountSessionActivity.lastSeenAt,
      revokedAt: accountSessionActivity.revokedAt,
      revokedReason: accountSessionActivity.revokedReason,
      ip: accountSessionActivity.ip,
      userAgent: accountSessionActivity.userAgent,
    })
    .from(accountSessionActivity)
    .where(eq(accountSessionActivity.accountId, accountId))
    .orderBy(sql`${accountSessionActivity.lastSeenAt} DESC`)
    .limit(200);

  return c.json({
    sessions: rows.map((r) => ({
      user_id: r.userId,
      session_id: r.sessionId,
      first_seen_at: r.firstSeenAt.toISOString(),
      last_seen_at: r.lastSeenAt.toISOString(),
      revoked_at: r.revokedAt?.toISOString() ?? null,
      revoked_reason: r.revokedReason,
      ip: r.ip,
      user_agent: r.userAgent,
    })),
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/sessions/{sessionId}/revoke',
    tags: ['iam'],
    summary: 'Revoke (force-logout) a session',
    ...auth,
    request: { params: z.object({ accountId: z.string(), sessionId: z.string() }), body: { content: { 'application/json': { schema: z.object({}).partial() } } } },
    responses: {
      200: json(z.object({ revoked: z.boolean() }), 'Revocation result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const actorUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const sessionId = c.req.param('sessionId');
  // Gate on member.remove — force-logout is roughly "kick this user off
  // for now"; reuses the same capability admins already grant.
  await assertAuthorized(actorUserId, accountId, ACCOUNT_ACTIONS.MEMBER_REMOVE);

  // Body optionally carries the target user (for safer audit). Either
  // way we just stamp revoked_at on the matching activity row.
  const rows = await db
    .update(accountSessionActivity)
    .set({
      revokedAt: sql`COALESCE(${accountSessionActivity.revokedAt}, now())`,
      revokedReason: sql`COALESCE(${accountSessionActivity.revokedReason}, 'admin')`,
      revokedBy: actorUserId,
    })
    .where(
      and(
        eq(accountSessionActivity.accountId, accountId),
        eq(accountSessionActivity.sessionId, sessionId),
      ),
    )
    .returning({ userId: accountSessionActivity.userId });

  if (rows.length === 0) {
    return c.json({ error: 'session not found' }, 404);
  }

  await auditIam(c, {
    accountId,
    action: 'iam.session.revoke',
    resourceType: 'session',
    resourceId: sessionId,
    after: { user_id: rows[0].userId, revoked_by: actorUserId },
  });

  return c.json({ revoked: true });
  },
);

// ─── PAT lifecycle policy ─────────────────────────────────────────────────
// Per-account ceilings on CLI Personal Access Token lifetime + idle gap,
// plus a "require expiry on every PAT" toggle. Enforced at mint
// (createAccountToken) and validate (validateAccountToken) paths.
// Project-scoped tokens (sandbox-injected) are exempt at both sites.

const PAT_MAX_LIFETIME_DAYS = 365 * 2; // 2 years
const PAT_MAX_IDLE_DAYS = 365;

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/pat-policy',
    tags: ['iam'],
    summary: 'Get the account PAT policy',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ max_lifetime_days: z.number().nullable(), require_expiry: z.boolean(), idle_revoke_days: z.number().nullable() }), 'PAT policy'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({
      maxLifetimeDays: accounts.patMaxLifetimeDays,
      requireExpiry: accounts.patRequireExpiry,
      idleRevokeDays: accounts.patIdleRevokeDays,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);

  return c.json({
    max_lifetime_days: row.maxLifetimeDays,
    require_expiry: row.requireExpiry,
    idle_revoke_days: row.idleRevokeDays,
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/pat-policy',
    tags: ['iam'],
    summary: 'Update the account PAT policy',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ max_lifetime_days: z.number().nullable(), maxLifetimeDays: z.number().nullable(), idle_revoke_days: z.number().nullable(), idleRevokeDays: z.number().nullable(), require_expiry: z.boolean(), requireExpiry: z.boolean() }).partial() } } } },
    responses: {
      200: json(z.object({ max_lifetime_days: z.number().nullable(), require_expiry: z.boolean(), idle_revoke_days: z.number().nullable() }), 'Updated PAT policy'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);

  function parseDays(key: string, value: unknown, max: number): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new HttpError(400, `${key} must be a positive integer or null`);
    }
    if (value > max) {
      throw new HttpError(400, `${key} cannot exceed ${max} days`);
    }
    return value;
  }

  let maxLifetimeDays: number | null | undefined;
  let idleRevokeDays: number | null | undefined;
  let requireExpiry: boolean | undefined;
  try {
    maxLifetimeDays = parseDays(
      'max_lifetime_days',
      body.max_lifetime_days ?? body.maxLifetimeDays,
      PAT_MAX_LIFETIME_DAYS,
    );
    idleRevokeDays = parseDays(
      'idle_revoke_days',
      body.idle_revoke_days ?? body.idleRevokeDays,
      PAT_MAX_IDLE_DAYS,
    );
    const reqRaw = body.require_expiry ?? body.requireExpiry;
    if (reqRaw !== undefined) {
      if (typeof reqRaw !== 'boolean') {
        return c.json({ error: 'require_expiry must be a boolean' }, 400);
      }
      requireExpiry = reqRaw;
    }
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const [before] = await db
    .select({
      maxLifetimeDays: accounts.patMaxLifetimeDays,
      requireExpiry: accounts.patRequireExpiry,
      idleRevokeDays: accounts.patIdleRevokeDays,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (maxLifetimeDays !== undefined) updates.patMaxLifetimeDays = maxLifetimeDays;
  if (idleRevokeDays !== undefined) updates.patIdleRevokeDays = idleRevokeDays;
  if (requireExpiry !== undefined) updates.patRequireExpiry = requireExpiry;

  await db
    .update(accounts)
    .set(updates)
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: 'iam.pat_policy.update',
    resourceType: 'account',
    resourceId: accountId,
    before: {
      max_lifetime_days: before.maxLifetimeDays,
      require_expiry: before.requireExpiry,
      idle_revoke_days: before.idleRevokeDays,
    },
    after: {
      max_lifetime_days:
        maxLifetimeDays !== undefined ? maxLifetimeDays : before.maxLifetimeDays,
      require_expiry:
        requireExpiry !== undefined ? requireExpiry : before.requireExpiry,
      idle_revoke_days:
        idleRevokeDays !== undefined ? idleRevokeDays : before.idleRevokeDays,
    },
  });

  return c.json({
    max_lifetime_days:
      maxLifetimeDays !== undefined ? maxLifetimeDays : before.maxLifetimeDays,
    require_expiry:
      requireExpiry !== undefined ? requireExpiry : before.requireExpiry,
    idle_revoke_days:
      idleRevokeDays !== undefined ? idleRevokeDays : before.idleRevokeDays,
  });
  },
);
