// Auth-side server endpoints. Currently just /v1/auth/logout — we
// don't (yet) own sign-in or token refresh server-side; Supabase
// handles that client-side. The logout endpoint exists so we can:
//
//   1. Emit an `auth.logout` audit event with the actor and session
//      id (the client-only signOut() can't generate audit events).
//   2. Mark the per-account session activity row as revoked so the
//      session-gate denies the rest of the session immediately
//      (instead of waiting for Supabase to refuse the next refresh).
//
// The client still calls supabase.auth.signOut() in parallel to
// invalidate the refresh token at Supabase's end.

import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { accountSessionActivity } from '@kortix/db';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import type { AppEnv } from '../types';
import { auditLogout } from '../shared/auth-audit';
import { makeOpenApiApp, json, errors, auth } from '../openapi';
import { gotrue } from './gotrue';

export const authRouter = makeOpenApiApp<AppEnv>();

authRouter.use('/*', supabaseAuth);

/**
 * POST /v1/auth/logout — explicit server-side logout for the calling
 * session. Revokes the session in our activity table (so the gate
 * denies any further request in the same access-token window) and
 * emits an audit event. Always returns 200, even when there's nothing
 * to revoke — clients shouldn't have to handle "I'm not signed in"
 * errors on a logout call.
 */
authRouter.openapi(
  createRoute({
    method: 'post',
    path: '/logout',
    tags: ['auth'],
    summary: 'Server-side logout for the calling session',
    ...auth,
    responses: {
      200: json(
        z.object({ ok: z.boolean(), revoked_session_rows: z.number() }),
        'Logout processed (always 200)',
      ),
      ...errors(401),
    },
  }),
  async (c) => {
  const userId = c.get('userId') as string;
  // sessionId / accountId are set by the auth middleware via untyped
  // c.set() — typed envs make these getters error-out at the strict
  // type level, so reach through `any` for those two reads only.
  const sessionId = (c as unknown as { get(k: string): unknown }).get(
    'sessionId',
  ) as string | undefined;
  const accountId =
    ((c as unknown as { get(k: string): unknown }).get('accountId') as
      | string
      | undefined) ?? null;

  // Mark every account_session_activity row for this session as
  // revoked across ALL accounts the user has visited under it. Users
  // typically have one account context per session, but multi-tenant
  // dashboards can hit several — the safe move is to revoke them all
  // on explicit logout.
  let revokedCount = 0;
  if (sessionId) {
    const rows = await db
      .update(accountSessionActivity)
      .set({
        revokedAt: sql`COALESCE(${accountSessionActivity.revokedAt}, now())`,
        revokedReason: sql`COALESCE(${accountSessionActivity.revokedReason}, 'user_action')`,
        revokedBy: userId,
      })
      .where(
        and(
          eq(accountSessionActivity.userId, userId),
          eq(accountSessionActivity.sessionId, sessionId),
        ),
      )
      .returning({ accountId: accountSessionActivity.accountId });
    revokedCount = rows.length;
  }

  auditLogout({
    c,
    userId,
    accountId,
    sessionId: sessionId ?? null,
    reason: 'user_action',
  });

  return c.json({ ok: true, revoked_session_rows: revokedCount });
});

// ─── Headless regular auth: the bearer-carrying half ─────────────────────────
// The public half (signup, sign-in, magic link, refresh, reset) is
// ./headless.ts, mounted on the same /v1/auth prefix ahead of this router.

function bearerOf(c: any): string | null {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

authRouter.openapi(
  createRoute({
    method: 'get',
    path: '/user',
    tags: ['auth'],
    summary: 'The Supabase user behind the bearer (headless)',
    ...auth,
    responses: {
      200: json(z.object({ user: z.object({ id: z.string() }).passthrough() }), 'The user'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const token = bearerOf(c);
    if (!token || (c.get('authType') as string) !== 'supabase') {
      return c.json({ error: 'invalid_token', error_description: 'This route needs a Supabase session bearer' }, 401);
    }
    const result = await gotrue<Record<string, unknown>>('/user', { bearer: token });
    if (!result.ok) return c.json({ error: result.body.error ?? 'auth_error', error_description: result.body.error_description ?? '' }, result.status as never);
    return c.json({ user: result.body });
  },
);

authRouter.openapi(
  createRoute({
    method: 'post',
    path: '/password/update',
    tags: ['auth'],
    summary: 'Set a new password for the signed-in user (headless)',
    ...auth,
    request: { body: { content: { 'application/json': { schema: z.object({ password: z.string().min(8).max(256) }) } } } },
    responses: {
      200: json(z.object({ user: z.object({ id: z.string() }).passthrough() }), 'Updated'),
      ...errors(400, 401, 422),
    },
  }),
  async (c: any) => {
    const token = bearerOf(c);
    if (!token || (c.get('authType') as string) !== 'supabase') {
      return c.json({ error: 'invalid_token', error_description: 'This route needs a Supabase session bearer' }, 401);
    }
    const body = c.req.valid('json');
    const result = await gotrue<Record<string, unknown>>('/user', { method: 'PUT', bearer: token, body: { password: body.password } });
    if (!result.ok) return c.json({ error: result.body.error ?? 'auth_error', error_description: result.body.error_description ?? '' }, result.status as never);
    return c.json({ user: result.body });
  },
);

authRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sign-out',
    tags: ['auth'],
    summary: 'Sign out at Supabase and revoke the Kortix session (headless)',
    ...auth,
    request: { body: { content: { 'application/json': { schema: z.object({ scope: z.enum(['global', 'local', 'others']).optional() }) } }, required: false } },
    responses: { 200: json(z.object({ ok: z.literal(true) }), 'Signed out (always 200)'), ...errors(401) },
  }),
  async (c: any) => {
    const token = bearerOf(c);
    const scope = ((await c.req.json().catch(() => ({}))) as { scope?: string }).scope ?? 'global';
    if (token && (c.get('authType') as string) === 'supabase') {
      // Best effort: the local revoke below is what the Kortix gate reads.
      await gotrue('/logout', { method: 'POST', bearer: token, body: {}, query: { scope } });
    }
    const userId = c.get('userId') as string;
    const sessionId = (c as unknown as { get(k: string): unknown }).get('sessionId') as string | undefined;
    const accountId = ((c as unknown as { get(k: string): unknown }).get('accountId') as string | undefined) ?? null;
    if (sessionId) {
      await db
        .update(accountSessionActivity)
        .set({
          revokedAt: sql`COALESCE(${accountSessionActivity.revokedAt}, now())`,
          revokedReason: sql`COALESCE(${accountSessionActivity.revokedReason}, 'user_action')`,
          revokedBy: userId,
        })
        .where(and(eq(accountSessionActivity.userId, userId), eq(accountSessionActivity.sessionId, sessionId)))
        .catch(() => {});
    }
    auditLogout({ c, userId, accountId, sessionId: sessionId ?? null });
    return c.json({ ok: true as const });
  },
);
