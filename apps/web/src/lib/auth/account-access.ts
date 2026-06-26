type AccountStateLike = {
  subscription?: { tier_key?: string | null } | null;
  tier?: { name?: string | null } | null;
  credits?: { can_run?: boolean | null } | null;
} | null | undefined;

/** True when the account may use the repo-first app (free tier included). */
export function accountHasAppAccess(accountState: AccountStateLike): boolean {
  if (!accountState) return true;

  const tierKey = (
    accountState.subscription?.tier_key ??
    accountState.tier?.name ??
    ''
  )
    .toString()
    .toLowerCase();

  if (tierKey === 'free') return true;
  if (tierKey && tierKey !== 'none') return true;
  return accountState.credits?.can_run === true;
}
