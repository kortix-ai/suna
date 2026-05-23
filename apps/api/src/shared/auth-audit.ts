// Auth-event audit helpers. Bundles the four auth-related event types
// (login success / fail / logout / session first-sight) behind tiny
// wrappers that pull IP + UA from the Hono context and never throw —
// auth audits are observational, not load-bearing.
//
// Action namespace:
//   auth.login.success            — verified credentials, request proceeds
//   auth.login.fail               — 401 about to be returned to client
//   auth.logout                   — explicit /v1/auth/logout call
//   auth.session.first_sight      — session_id seen for the first time
//                                   against a given account
//
// All four go through the same recordAuditEvent() pipe as everything
// else, so existing webhook + viewer + export tooling picks them up
// with no extra wiring.

import type { Context } from 'hono';
import { recordAuditEvent } from './audit';

function clientIp(c: Context): string | null {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null
  );
}

function userAgent(c: Context): string | null {
  return c.req.header('user-agent') || null;
}

/**
 * Fire-and-forget — auth events must never block the request path.
 * Failures are logged and swallowed.
 */
function fireAndForget(promise: Promise<void>): void {
  promise.catch((err) => {
    console.warn('[auth-audit] failed to record event', err);
  });
}

/** Successful credential verification. Called from auth middleware
 *  right after a token (JWT, PAT, SA, Kortix key) passes validation. */
export function auditLoginSuccess(args: {
  c: Context;
  userId: string;
  accountId?: string | null;
  authType: 'supabase' | 'pat' | 'apiKey' | 'service_account';
  metadata?: Record<string, unknown>;
}): void {
  fireAndForget(
    recordAuditEvent({
      accountId: args.accountId ?? null,
      actorUserId: args.userId,
      action: 'auth.login.success',
      resourceType: 'session',
      ip: clientIp(args.c),
      userAgent: userAgent(args.c),
      metadata: {
        auth_type: args.authType,
        ...args.metadata,
      },
    }),
  );
}

/** 401 about to be returned. Called from every throw site in the auth
 *  middleware so the audit log carries an intrusion-attempt signal
 *  even when the principal is unknown. */
export function auditLoginFail(args: {
  c: Context;
  reason: string;
  /** Best-effort hint for which token kind was attempted ('jwt',
   *  'pat', 'apiKey', 'service_account'). */
  authType?: string;
  /** Optional principal hint when we got far enough to know it
   *  (e.g. token validated but business check failed). */
  userId?: string | null;
  accountId?: string | null;
}): void {
  fireAndForget(
    recordAuditEvent({
      accountId: args.accountId ?? null,
      actorUserId: args.userId ?? null,
      action: 'auth.login.fail',
      resourceType: 'session',
      ip: clientIp(args.c),
      userAgent: userAgent(args.c),
      metadata: {
        reason: args.reason,
        ...(args.authType ? { auth_type: args.authType } : {}),
      },
    }),
  );
}

/** Explicit logout. Called from the /v1/auth/logout route after the
 *  session is revoked. */
export function auditLogout(args: {
  c: Context;
  userId: string;
  accountId?: string | null;
  sessionId?: string | null;
  reason?: 'user_action' | 'admin_revoke';
}): void {
  fireAndForget(
    recordAuditEvent({
      accountId: args.accountId ?? null,
      actorUserId: args.userId,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: args.sessionId ?? null,
      ip: clientIp(args.c),
      userAgent: userAgent(args.c),
      metadata: { reason: args.reason ?? 'user_action' },
    }),
  );
}

/** First time we observe a session_id against this account. Fires
 *  from session-gate when it inserts a fresh activity row. Useful
 *  for "where is this user signing in from" investigations. */
export function auditSessionFirstSight(args: {
  c: Context;
  userId: string;
  accountId: string;
  sessionId: string;
}): void {
  fireAndForget(
    recordAuditEvent({
      accountId: args.accountId,
      actorUserId: args.userId,
      action: 'auth.session.first_sight',
      resourceType: 'session',
      resourceId: args.sessionId,
      ip: clientIp(args.c),
      userAgent: userAgent(args.c),
    }),
  );
}
