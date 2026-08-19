import { resolveScopedAccountId } from '../shared/resolve-account';
import { assertAuthorized } from '../iam/authorize';
import { actorOf } from '../iam/actor';
import { ACCOUNT_ACTIONS } from '../iam/actions';

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
  c: any,
  source: 'query' | 'body' = 'body',
): Promise<string> {
  const accountId = await resolveScopedAccountId(c, source);
  await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.BILLING_WRITE);
  return accountId;
}
