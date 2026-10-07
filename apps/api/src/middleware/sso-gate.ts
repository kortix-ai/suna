// SSO only, for every request to one account (`/v1/accounts/:accountId/...`).
// Project routes reach `authorize`, which applies the same gate; many account
// routes decide on membership alone, so the gate runs here once for all of
// them. A caller who is not a member passes through to the route's own answer.

import type { Context, MiddlewareHandler } from 'hono';
import { ssoRequiredFor } from '../iam/authorize';
import { buildDenialError } from '../iam/denial-message';
import { actorOf } from './actor';

const ACCOUNT_PATH = /^\/v1\/accounts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function accountSsoGate(): MiddlewareHandler {
  return async (c: Context, next) => {
    const accountId = ACCOUNT_PATH.exec(c.req.path)?.[1];
    if (accountId && (await ssoRequiredFor(await actorOf(c, accountId)))) {
      throw buildDenialError('account.read', 'sso_required');
    }
    await next();
  };
}
