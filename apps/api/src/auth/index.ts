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
