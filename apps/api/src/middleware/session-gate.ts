// The per-account session policy gate as request middleware. The policy reads,
// the verdict and the activity writes live in `iam/session-gate.ts`.

import type { Context, MiddlewareHandler } from 'hono';
import { evaluateSessionGate, loadPolicyAndActivity, markRevoked, touchActivity } from '../iam/session-gate';
import { auditSessionFirstSight } from './auth-audit';
import { requestClientIp } from './client-ip';
import { deadCredential401 } from '../shared/dead-credential-log';
import { accountIdParam } from '../shared/route-params';
import { isUuid } from '../shared/validate';

/**
 * Mount this on /v1/accounts/:accountId/* AFTER auth middleware. It
 * needs userId, sessionId, sessionIat populated on context.
 *
 * The same check also runs in `actorOf` (middleware/actor.ts) for every
 * route that authorizes against an account, so the policy covers every
 * route of the workspace, not only the account subtrees (finding 12). Both
 * share one per-request memo (`enforceSessionPolicy`): the policy is read and
 * the idle activity is touched once per request and account.
 */
export function accountSessionGate(): MiddlewareHandler {
  return async (c: Context, next) => {
    const accountId =
      accountIdParam(c) ?? c.req.param('id') ?? (c.get('accountId') as string | undefined);
    if (accountId) await enforceSessionPolicy(c, accountId);
    await next();
  };
}

/** request -> account id -> the one policy check of that request. */
const checksByRequest = new WeakMap<Request, Map<string, Promise<void>>>();

/**
 * Enforce `accountId`'s session policy (max lifetime, idle timeout,
 * force-logout) on this request's Supabase session. A no-op for every other
 * credential: PATs and API keys carry no session and are governed by the
 * token policies. Throws `401 session_token_revoked` for a dead session.
 * Memoized per request and account.
 */
export function enforceSessionPolicy(c: Context, accountId: string): Promise<void> {
  if (!accountId || !isUuid(accountId)) return Promise.resolve();
  if ((c.get('authType') as string | undefined) !== 'supabase') return Promise.resolve();
  const raw = c.req.raw;
  let checks = checksByRequest.get(raw);
  if (!checks) {
    checks = new Map();
    checksByRequest.set(raw, checks);
  }
  const key = accountId.toLowerCase();
  let check = checks.get(key);
  if (!check) {
    check = checkSessionPolicy(c, key);
    checks.set(key, check);
  }
  return check;
}


async function checkSessionPolicy(c: Context, accountId: string): Promise<void> {
  const userId = c.get('userId') as string | undefined;
  const sessionId = c.get('sessionId') as string | undefined;
  // A JWT without a session_id is the pre-Supabase-3.0 token shape: ungatable,
  // and a real, valid token is never blocked for it.
  if (!userId || !sessionId) return;

  const policy = await loadPolicyAndActivity(accountId, userId, sessionId);
  // The account does not exist: the downstream route answers for itself.
  if (!policy) return;
  // No policy AND no force-logout outstanding: skip the write entirely. Hot
  // path on accounts that have not opted in.
  if (policy.maxLifetimeMinutes == null && policy.idleTimeoutMinutes == null && !policy.revokedAt) return;

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
    // Persist the revocation reason so the next request through this session
    // short-circuits without re-evaluating gates, a refreshed token included
    // (a refresh keeps the session_id).
    if (verdict === 'idle_timeout' || verdict === 'lifetime_exceeded') {
      await markRevoked(accountId, userId, sessionId, verdict === 'idle_timeout' ? 'idle' : 'lifetime', ip, userAgent).catch(
        (err) => {
          console.warn('[session-gate] markRevoked failed', err);
        },
      );
    }
    // A dead session is a dead credential (KRTX-446/1039 class): the session
    // can never come back, only a fresh sign-in restores access.
    // `deadCredential401` gives the reading client the machine-readable stop
    // signal (`code: 'session_token_revoked'`) and marks the exception so the
    // global error handler's dead-credential log throttle bounds the warn lines
    // a NON-reading client produces — prod 2026-10-14 20:55–21:00 UTC: one
    // browser polling eight account routes with a just-revoked session wrote
    // 113 warn lines in five minutes (KRTX-2369), every one the gate working as
    // designed. The response status and message are unchanged.
    throw deadCredential401(`session ${verdict.replace('_', ' ')} — please sign in again`);
  }

  // Update last_seen lazily. When the activity row is INSERTED (the first time
  // this session is seen against this account), emit an
  // `auth.session.first_sight` audit event. Fire-and-forget: the request never
  // waits on activity/audit writes.
  const ip = requestClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;
  void touchActivity(accountId, userId, sessionId, ip, userAgent, policy.lastSeenAt)
    .then((result) => {
      if (result.firstSight) {
        return auditSessionFirstSight({ c, userId, accountId, sessionId });
      }
    })
    .catch((err) => {
      console.warn('[session-gate] session activity/first-sight audit failed', err);
    });
}
