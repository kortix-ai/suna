type AccountStateLike = {
  /** The RESOLVED plan (billing/services/resolve-billing.ts). Authoritative
   *  when present; `subscription.tier_key` is only the STORED plan. */
  plan?: { key?: string | null } | null;
  subscription?: { tier_key?: string | null } | null;
  tier?: { name?: string | null } | null;
  credits?: { can_run?: boolean | null } | null;
} | null | undefined;

/** True when the account may use the repo-first app (free tier included). */
export function accountHasAppAccess(accountState: AccountStateLike): boolean {
  if (!accountState) return true;

  // The plan the account BEHAVES as, falling back to the stored tier for an
  // API older than the plan resolver. An account on an admin trial carries a
  // real plan here while `subscription.tier_key` still reads its stored value,
  // so reading the stored key alone could send a trialing account down the
  // credits path.
  const planKey = (
    accountState.plan?.key ??
    accountState.subscription?.tier_key ??
    accountState.tier?.name ??
    ''
  )
    .toString()
    .toLowerCase();

  if (planKey === 'free') return true;
  if (planKey && planKey !== 'none') return true;
  return accountState.credits?.can_run === true;
}
