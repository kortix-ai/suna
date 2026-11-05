// SSO only, for every request to one account (`/v1/accounts/:workspaceId/...`,
// `/v1/workspaces/:workspaceId/<account family>/...`).
// Project routes reach `authorize`, which applies the same gate; many account
// routes decide on membership alone, so the gate runs here once for all of
// them. A caller who is not a member passes through to the route's own answer.

import type { Context, MiddlewareHandler } from 'hono';
import { ssoRequiredFor } from '../iam/authorize';
import { buildDenialError } from '../iam/denial-message';
import { isUuid } from '../shared/validate';
import { actorOf } from './actor';
import { WORKSPACE_ACCOUNT_ID_VAR } from '../shared/route-params';

export function accountSsoGate(): MiddlewareHandler {
  return async (c: Context, next) => {
    // `/v1/accounts/<id>/...` or `/v1/workspaces/<id>/...`: the account key the
    // workspace resolver mapped the path id to, else the raw segment.
    const accountId = (c.get(WORKSPACE_ACCOUNT_ID_VAR) as string | undefined) ?? c.req.path.split('/')[3];
    if (accountId && isUuid(accountId) && (await ssoRequiredFor(await actorOf(c, accountId)))) {
      throw buildDenialError('account.read', 'sso_required');
    }
    await next();
  };
}
