import type { Context } from 'hono';
import { scopedAccountIdFor } from '../shared/resolve-account';

/**
 * Resolve the account a billing request should target.
 *
 * Multi-account users (one user, multiple Kortix accounts) need every billing
 * route to be account-scoped — otherwise mutating "Subscribe" or "Manage
 * billing" or even reading "account-state" silently target the user's FIRST
 * membership, which makes /accounts/<other>?tab=billing nonsensical.
 *
 * Resolution order:
 *   1. `?account_id=` / `?workspace_id=` (query) or `body.account_id` /
 *      `body.workspace_id` if provided (either id) → verify the
 *      caller is a member of that account, then return it. 403 on miss.
 *   2. The account the credential is bound to (`c.get('accountId')`: a PAT,
 *      an API key, a service account), when set.
 *   3. The user's primary membership. 409 `no_workspace` when the user
 *      belongs to no account (`shared/resolve-account.ts`).
 *
 * Pass `source: 'body'` for POST/PUT/PATCH/DELETE routes (we read the JSON
 * body once and look for `account_id`). Pass `source: 'query'` for GETs.
 */
export async function resolveScopedAccountId(
  c: Context,
  source: 'query' | 'body' = 'query',
): Promise<string> {
  const userId = c.get('userId') as string;

  let requested: string | undefined;
  if (source === 'query') {
    // `workspace_id` is the canonical name; `account_id` keeps working (both take either id).
    requested = c.req.query('account_id') ?? c.req.query('workspace_id');
  } else {
    try {
      // Use Hono's cached body parse (c.req.json()), NOT c.req.raw.clone().json():
      // under @hono/zod-openapi the request-validation middleware consumes the raw
      // body stream before the handler runs, so a clone of c.req.raw is empty by
      // then → account_id would be missed → a non-member would resolve to their
      // own account instead of being 403'd. c.req.json() returns the cached parse.
      const body = await c.req.json();
      const candidate = body?.account_id ?? body?.workspace_id;
      if (typeof candidate === 'string' && candidate) requested = candidate;
    } catch {
      // No JSON body or malformed — that's fine, fall through.
    }
  }

  return scopedAccountIdFor(userId, requested, c.get('accountId') as string | undefined);
}
