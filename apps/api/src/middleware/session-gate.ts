// The per-account session policy gate as request middleware. The policy reads,
// the verdict and the activity writes live in `iam/session-gate.ts`.

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { evaluateSessionGate, loadPolicyAndActivity, markRevoked, touchActivity } from '../iam/session-gate';
import { auditSessionFirstSight } from './auth-audit';
import { requestClientIp } from './client-ip';

/**
 * Mount this on /v1/accounts/:accountId/* AFTER auth middleware. It
 * needs userId, sessionId, sessionIat populated on context.
 */
export function accountSessionGate(): MiddlewareHandler {
  return async (c: Context, next) => {
    const accountId =
      c.req.param('accountId') ?? c.req.param('id') ?? (c.get('accountId') as string | undefined);
    if (!accountId) {
      // Routes without an :accountId can't be gated; nothing to do.
      await next();
      return;
    }

    // PATs and Kortix API keys don't carry a session_id — they're
    // already governed by token lifecycle policies elsewhere.
    const authType = c.get('authType') as string | undefined;
    if (authType !== 'supabase') {
      await next();
      return;
    }

    const userId = c.get('userId') as string | undefined;
    const sessionId = c.get('sessionId') as string | undefined;
    if (!userId || !sessionId) {
      // JWT didn't carry a session_id — pre-Supabase-3.0 token shape.
      // Treat as ungatable; never block a real, valid token.
      await next();
      return;
    }

    const policy = await loadPolicyAndActivity(accountId, userId, sessionId);
    if (!policy) {
      // Account doesn't exist; let the downstream route 404 with its
      // own message instead of inventing one here.
      await next();
      return;
    }
    if (
      policy.maxLifetimeMinutes == null &&
      policy.idleTimeoutMinutes == null &&
      !policy.revokedAt
    ) {
      // No policy AND no force-logout outstanding → skip the write
      // entirely. Hot-path on accounts that haven't opted in.
      await next();
      return;
    }

    const iatSeconds = c.get('sessionIat') as number | undefined;
    const verdict = evaluateSessionGate({
      nowMs: Date.now(),
      iatSeconds: typeof iatSeconds === 'number' ? iatSeconds : null,
      maxLifetimeMinutes: policy.maxLifetimeMinutes,
      idleTimeoutMinutes: policy.idleTimeoutMinutes,
      lastSeenAt: policy.lastSeenAt,
      revokedAt: policy.revokedAt,
    });

    if (verdict !== 'allow') {
      const ip = requestClientIp(c);
      const userAgent = c.req.header('user-agent') ?? null;
      // Persist the revocation reason so the next request through
      // this session short-circuits without re-evaluating gates.
      if (verdict === 'idle_timeout' || verdict === 'lifetime_exceeded') {
        await markRevoked(
          accountId,
          userId,
          sessionId,
          verdict === 'idle_timeout' ? 'idle' : 'lifetime',
          ip,
          userAgent,
        ).catch((err) => {
          console.warn('[session-gate] markRevoked failed', err);
        });
      }
      throw new HTTPException(401, {
        message: `session ${verdict.replace('_', ' ')} — please sign in again`,
      });
    }

    // Update last_seen lazily. When the activity row is INSERTED (i.e.
    // this is the first time we've seen this session against this
    // account), emit an `auth.session.first_sight` audit event so the
    // log captures "new device / new browser tab signed in" without
    // needing a separate signal from the OAuth callback.
    const ip = requestClientIp(c);
    const userAgent = c.req.header('user-agent') ?? null;
    // Fire-and-forget: the request must never wait on activity/audit writes. The
    // trailing .catch covers touchActivity's rejection. auditSessionFirstSight
    // already self-catches (returns void via fireAndForget), so it can't reject
    // today — we still `return` it and `void` the chain so the floating promise
    // is explicit and the single .catch stays the guard if that ever changes.
    void touchActivity(accountId, userId, sessionId, ip, userAgent, policy.lastSeenAt)
      .then((result) => {
        if (result.firstSight) {
          return auditSessionFirstSight({ c, userId, accountId, sessionId });
        }
      })
      .catch((err) => {
        console.warn('[session-gate] session activity/first-sight audit failed', err);
      });

    await next();
  };
}
