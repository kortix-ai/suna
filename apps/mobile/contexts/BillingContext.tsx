/**
 * Billing Context — DISABLED
 *
 * Billing is currently disabled for self-hosted / local development.
 * This module exports the same interface as the real BillingProvider
 * but returns static no-op values so all consumers continue to work
 * without making any billing API calls.
 *
 * To re-enable billing, restore the original implementation from git history.
 */

import React, { createContext, useContext, ReactNode } from 'react';
import type { SubscriptionInfo, CreditBalance, BillingStatus } from '@/lib/billing';

// ============================================================================
// Context Types (unchanged — consumers depend on this shape)
// ============================================================================

export interface BillingContextType {
  subscriptionData: SubscriptionInfo | null;
  creditBalance: CreditBalance | null;
  billingStatus: BillingStatus | null;

  isLoading: boolean;
  subscriptionLoading: boolean;
  balanceLoading: boolean;
  statusLoading: boolean;

  error: Error | null;

  refetchAll: () => void;
  refetchSubscription: () => void;
  refetchBalance: () => void;
  refetchStatus: () => void;
  checkBillingStatus: () => Promise<boolean>;

  hasActiveSubscription: boolean;
  hasFreeTier: boolean;
  needsSubscription: boolean;
}

// ============================================================================
// Static disabled value — no API calls, no loading, no errors
// ============================================================================

const noop = () => {};

const DISABLED_VALUE: BillingContextType = {
  subscriptionData: null,
  creditBalance: null,
  billingStatus: null,

  isLoading: false,
  subscriptionLoading: false,
  balanceLoading: false,
  statusLoading: false,

  error: null,

  refetchAll: noop,
  refetchSubscription: noop,
  refetchBalance: noop,
  refetchStatus: noop,
  checkBillingStatus: async () => true, // Always allow — no billing gate

  hasActiveSubscription: true, // Treat as "subscribed" so nothing is gated
  hasFreeTier: false,
  needsSubscription: false,
};

// ============================================================================
// Context & Provider
// ============================================================================

const BillingContext = createContext<BillingContextType>(DISABLED_VALUE);

interface BillingProviderProps {
  children: ReactNode;
}

/**
 * No-op billing provider. Renders children directly without any billing logic.
 * All billing hooks return static "billing disabled" values.
 */
export function BillingProvider({ children }: BillingProviderProps) {
  return <BillingContext.Provider value={DISABLED_VALUE}>{children}</BillingContext.Provider>;
}

// ============================================================================
// Hooks (same API, static returns)
// ============================================================================

export function useBillingContext(): BillingContextType {
  return useContext(BillingContext);
}

export function useHasCredits(_minimumCredits = 0): boolean {
  return true; // Always has credits when billing is disabled
}

export function useSubscriptionTier(): string {
  return 'none'; // No tier concept when billing is disabled
}
