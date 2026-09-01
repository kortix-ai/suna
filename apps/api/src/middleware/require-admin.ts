import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getPlatformRole } from '../shared/platform-roles';
import { getImpersonationContext } from '../shared/impersonation';

export async function requireAdmin(c: Context, next: Next) {
  const accountId = c.get('userId') as string | undefined;
  if (!accountId) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  // No admin surface is reachable while impersonating. requireAdmin reads the
  // REAL operator's user id (impersonation leaves `userId` untouched), so a
  // platform-admin operator would otherwise pass every requireAdmin-gated
  // router — /v1/admin, /v1/platform/github-app, /v1/ops,
  // an operator-only source registration — while the request is attributed to the customer
  // account. Enforce the block here, at the one gate they all share, instead
  // of enumerating their path prefixes in the impersonation deny-list.
  if (getImpersonationContext()) {
    throw new HTTPException(403, {
      message: 'Admin surfaces are not reachable while impersonating an account',
    });
  }

  const role = await getPlatformRole(accountId);
  if (role !== 'admin' && role !== 'super_admin') {
    throw new HTTPException(403, { message: 'Admin access required' });
  }

  c.set('platformRole', role);
  await next();
}
