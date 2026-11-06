/**
 * The per-request gates of every account-key route, in order.
 *
 * `accountsRouter` (`/v1/accounts/…`) and its canonical alias
 * (`/v1/workspaces/:workspaceId/<family>/…`, `workspaces/index.ts`) run the
 * same chain:
 *
 *   1. the workspace resolver maps the path id (a workspace id or an account
 *      key) to the account key that `accountIdParam(c)` returns;
 *   2. the session gate enforces that account's session policy (max lifetime,
 *      idle timeout, force-logout); a route with no account in the path is
 *      gated by the caller's active account;
 *   3. the SSO gate judges the same account;
 *   4. a closing workspace answers its owners only (404 workspace_not_found).
 *
 * The resolver runs first. Before it did, the session gate on a canonical
 * route read the raw workspace id (a `project_id`), found no account row and
 * let every request through.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { accountSessionGate } from '../iam/session-gate';
import { accountClosingGate, accountSsoGate } from '../middleware/sso-gate';
import { resolveWorkspaceAccount, workspacePathSegment } from '../middleware/workspace-account';
import { isNoWorkspaceError } from '../shared/no-workspace';
import { resolveAccountId } from '../shared/resolve-account';
import { WORKSPACE_ACCOUNT_ID_VAR } from '../shared/route-params';

function pathAccount(c: Context<AppEnv>): string | undefined {
  const value = (c as unknown as { get(k: string): unknown }).get(WORKSPACE_ACCOUNT_ID_VAR);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const sessionPolicyGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!pathAccount(c) && !c.get('accountId') && c.get('authType') === 'supabase') {
    const userId = c.get('userId') as string | undefined;
    const sessionId = c.get('sessionId') as string | undefined;
    if (userId && sessionId) {
      // A user with no workspace has no account policy to enforce: the gate
      // below stays a no-op for them, and the handler answers for itself
      // (GET /v1/accounts → []). Nothing is created here.
      try {
        c.set('accountId', await resolveAccountId(userId, { allowAccountCredential: false }));
      } catch (err) {
        if (!isNoWorkspaceError(err)) throw err;
      }
    }
  }
  return accountSessionGate()(c, next);
};

/** The ordered middleware chain; mount each with `router.use('/*', …)`. */
export function accountRequestGates(): MiddlewareHandler<AppEnv>[] {
  return [resolveWorkspaceAccount(workspacePathSegment), sessionPolicyGate, accountSsoGate(), accountClosingGate()];
}
