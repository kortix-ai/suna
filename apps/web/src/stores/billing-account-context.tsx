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
 */

const BillingAccountContext = React.createContext<string | null>(null);

export function BillingAccountProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  return (
    <BillingAccountContext.Provider value={accountId}>
      {children}
    </BillingAccountContext.Provider>
  );
}

/** Returns the explicit accountId from context, or undefined if not wrapped. */
export function useBillingAccountId(): string | undefined {
  const value = React.useContext(BillingAccountContext);
  return value ?? undefined;
}
