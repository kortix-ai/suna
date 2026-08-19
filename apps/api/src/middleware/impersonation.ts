/**
 * Resolves the `X-Kortix-Impersonate` header into a request-scoped act-as
 * context. Runs INSIDE `supabaseAuth` / `combinedAuth`, immediately after the
 * REAL user is resolved and before the route handler — see `withImpersonation`
 * in middleware/auth.ts for why it is wrapped there rather than mounted
 * globally (auth is mounted per sub-router, so a global `app.use('*')` would
 * run before any identity exists).
 *
 * The decision itself is pure (`decideImpersonation`); this file only does the
 * I/O around it: read the header, load the grant, look up the platform role,
 * publish the context, and audit the mutation.
 */

import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { recordAuditEvent } from '../shared/audit';
import {
  IMPERSONATION_ACTION_ACTION,
  IMPERSONATION_HEADER,
  IMPERSONATION_INVALID_CODE,
  decideImpersonation,
  loadImpersonationGrant,
  setImpersonationContext,
  type ImpersonationDenialReason,
} from '../shared/impersonation';
import { isPlatformAdmin } from '../shared/platform-roles';
import { setContextField } from '../lib/request-context';

/**
 * Every denial is the same 403 with the same code and the same message. The
 * `reason` is logged, never returned: telling a caller "that grant belongs to
 * someone else" vs "no such grant" turns the endpoint into an oracle for
 * enumerating live sessions.
 */
function denyImpersonation(c: Context, reason: ImpersonationDenialReason): never {
  console.warn(
    `[impersonation] denied reason=${reason} path=${c.req.path} user=${c.get('userId') ?? 'unknown'}`,
  );
  const body = JSON.stringify({
    error: 'Impersonation grant is not valid',
    code: IMPERSONATION_INVALID_CODE,
  });
  throw new HTTPException(403, {
    message: 'Impersonation grant is not valid',
    res: new Response(body, { status: 403, headers: { 'content-type': 'application/json' } }),
  });
}

/**
 * No header → ordinary request, zero added cost (no DB read, no role lookup).
 * Header present → validate or 403. There is no third outcome: falling back to
 * the admin's own account would let a mistyped grant id write to the wrong
 * account while the console still showed the customer's banner.
 */
export async function applyImpersonation(c: Context, next: Next): Promise<void> {
  const grantId = c.req.header(IMPERSONATION_HEADER)?.trim();
  if (!grantId) {
    await next();
    return;
  }

  const realUserId = c.get('userId') as string | undefined;
  if (!realUserId) denyImpersonation(c, 'grant_not_owned');

  const authType = c.get('authType') as string | undefined;
  const grant = await loadImpersonationGrant(grantId);
  // Only pay for the platform-role lookup once the grant itself checks out —
  // an attacker guessing ids never triggers it.
  const eligible =
    authType === 'supabase' && grant !== null && grant.adminUserId === realUserId;
  const decision = decideImpersonation({
    grant,
    realUserId,
    authType,
    isPlatformAdmin: eligible ? await isPlatformAdmin(realUserId) : false,
    path: c.req.path,
    method: c.req.method,
    now: new Date(),
  });
  if (!decision.ok) denyImpersonation(c, decision.reason);

  const published = setImpersonationContext({
    grantId: decision.grantId,
    targetAccountId: decision.targetAccountId,
    impersonatorUserId: realUserId,
  });
  // The AsyncLocalStorage store is how the target account reaches every access
  // check. Without it the request would run as the admin's OWN account while
  // the client believed it was acting as the customer — the exact silent
  // fallback this design forbids.
  if (!published) denyImpersonation(c, 'request_context_unavailable');

  // Hono-context mirrors for route handlers and the request-audit middleware.
  c.set('accountId', decision.targetAccountId);
  c.set('impersonationGrantId', decision.grantId);
  c.set('impersonatorUserId', realUserId);
  setContextField('accountId', decision.targetAccountId);

  // Audit BEFORE the handler runs, not after: an audit written on the way out
  // can be skipped by a handler that crashes the process, and this row is the
  // record of an operator touching customer data. GETs are deliberately not
  // audited per request (one page load is dozens of them) — `.start` and
  // `.stop` bracket the session, and `auditApiRequest` already logs every
  // request generically with the impersonated account id.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
    try {
      await recordAuditEvent({
        accountId: decision.targetAccountId,
        actorUserId: realUserId,
        actorType: 'human',
        action: IMPERSONATION_ACTION_ACTION,
        resourceType: 'account',
        resourceId: decision.targetAccountId,
        metadata: {
          method: c.req.method,
          // The CONCRETE path, not `routePath`. This middleware runs before
          // routing resolves, so `routePath` is the mount pattern the request
          // matched so far (`/v1/accounts/*`) — useless to whoever reads this
          // row later asking "what did the operator touch?".
          path: c.req.path,
          grant_id: decision.grantId,
          impersonator_user_id: realUserId,
          target_account_id: decision.targetAccountId,
        },
      });
    } catch (error) {
      // Best-effort by design: a failed audit insert must not deny a support
      // operator mid-incident. The denial paths above are the security gate;
      // this is the record of an already-authorized action.
      console.error('[impersonation] failed to record action audit:', error);
    }
  }

  await next();
}
