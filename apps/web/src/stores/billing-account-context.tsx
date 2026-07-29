'use client';

import * as React from 'react';

/**
 * BillingAccountContext — single source of truth for "which account is this
 * billing UI talking about". Wraps the per-account billing surface (the
 * `/accounts/[id]` Billing tab today). Every billing hook reads from this
 * context, so a multi-account user sees / mutates the account they're
 * actually viewing, not their first membership.
 *
 * `accountId === null` means "fall back to the user's primary account" —
 * used by global surfaces (user menu, upgrade dialog) that intentionally
 * stay account-agnostic.
 *
 * `resolved === false` is a *third* state, and it is not the same as `null`:
 * it means "this surface owns an account, we just don't know its id yet"
 * (the project shell before `project-detail` lands). Billing queries wait it
 * out rather than fetch the primary account as a stand-in — see
 * `shouldQueryAccountState`.
 */

interface BillingAccountContextValue {
  accountId: string | null;
  resolved: boolean;
}

const BillingAccountContext = React.createContext<BillingAccountContextValue | null>(null);

export function BillingAccountProvider({
  accountId,
  resolved = true,
  children,
}: {
  // `null` = fall back to the user's primary account (global surfaces).
  accountId: string | null;
  /** Pass `false` while the owning account is still being fetched. */
  resolved?: boolean;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ accountId, resolved }), [accountId, resolved]);
  return <BillingAccountContext.Provider value={value}>{children}</BillingAccountContext.Provider>;
}

/** Returns the explicit accountId from context, or undefined if not wrapped. */
export function useBillingAccountId(): string | undefined {
  return React.useContext(BillingAccountContext)?.accountId ?? undefined;
}

/**
 * True once the account this surface bills against is known. Outside any
 * provider this is always true: a global surface means "the primary account",
 * and that never needs resolving.
 */
export function useBillingAccountResolved(): boolean {
  return React.useContext(BillingAccountContext)?.resolved ?? true;
}
