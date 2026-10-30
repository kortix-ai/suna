import type { Context } from 'hono';
import { resolveScopedAccountId } from '../middleware/resolve-account';
import { assertAuthorized } from '../iam/authorize';
import { actorOf } from '../iam/actor';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import { HTTPException } from 'hono/http-exception';
import { enforceRateLimit } from '../middleware/rate-limit';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { RATE_LIMIT_EXCEEDED_ACTION } from '../shared/rate-limit-audit';

// ponytail: replica-local runaway protection, use a shared bucket if fleet-wide quotas become necessary.
const billingWriteLimiter = new TokenBucketRateLimiter('billing_write');
const billingPreviewLimiter = new TokenBucketRateLimiter('billing_preview');

/**
 * Resolve the account a billing *write* targets AND assert the caller is
 * allowed to change billing for it (`billing.write` — owners only by default,
 * see the `owner` role in kortix.role_permissions).
 *
 * Every endpoint that creates or changes a subscription, initiates a charge,
 * or opens the Stripe customer portal MUST go through here instead of bare
 * `resolveScopedAccountId`. Without the role gate, any account *member* — who
 * only has `billing.read` — can subscribe / cancel / top-up on the whole
 * account's behalf (they pass a valid bearer token + account_id and the call
 * sails straight through to Stripe).
 *
 * `resolveScopedAccountId` already verifies membership and scopes to the
 * requested account; this layers the role check on top. Throws
 * HTTPException(403) with a user-facing "You don't have permission to change
 * billing." on denial.
 */
export async function resolveBillingWriteAccountId(
  c: Context,
  source: 'query' | 'body' = 'body',
  budget: 'write' | 'preview' = 'write',
): Promise<string> {
  const accountId = await resolveScopedAccountId(c, source);
  await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.BILLING_WRITE);
  const limiter = budget === 'preview' ? billingPreviewLimiter : billingWriteLimiter;
  const denied = await enforceRateLimit(c, limiter, accountId, { limit: 5, windowMs: 60_000 }, {
    accountId,
    actorUserId: c.get('userId'),
    action: RATE_LIMIT_EXCEEDED_ACTION,
    resourceType: 'billing',
    resourceId: accountId,
    metadata: { limiter: budget === 'preview' ? 'billing_preview' : 'billing_write' },
  });
  if (denied) throw new HTTPException(429, { res: denied });
  return accountId;
}

/**
 * The read twin: the ledger reads (transactions, their summary, credit usage)
 * need `billing.read`. Membership alone is not enough: a custom role without
 * `billing.read` must not read the account's money history.
 */
export async function resolveBillingReadAccountId(
  c: Context,
  source: 'query' | 'body' = 'query',
): Promise<string> {
  const accountId = await resolveScopedAccountId(c, source);
  await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.BILLING_READ);
  return accountId;
}
