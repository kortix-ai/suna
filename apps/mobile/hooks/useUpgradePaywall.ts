/**
 * useUpgradePaywall Hook — DISABLED
 *
 * Billing/paywall is currently disabled for self-hosted / local development.
 * This module exports the same interface as the real hook but returns
 * static no-op values.
 *
 * To re-enable, restore the original implementation from git history.
 */

export type PaywallName = string;

export const PAYWALL_NAMES = {
  PLUS: 'plus',
  PRO: 'pro',
  ULTRA: 'ultra',
  TOPUPS: 'topups',
} as const;

export function getPaywallForTier(_tierKey: string | undefined | null): PaywallName {
  return PAYWALL_NAMES.PLUS;
}

export function isTopupsTier(_tierKey: string | undefined | null): boolean {
  return false;
}

export async function logAvailablePaywalls(): Promise<string[]> {
  return [];
}

export interface UpgradePaywallResult {
  useNativePaywall: boolean;
  currentPaywallName: PaywallName;
  isOnUltraTier: boolean;
  presentUpgradePaywall: () => Promise<{ purchased: boolean; cancelled: boolean }>;
}

/**
 * No-op paywall hook. Always returns "no native paywall, no purchase".
 */
export function useUpgradePaywall(): UpgradePaywallResult {
  return {
    useNativePaywall: false,
    currentPaywallName: PAYWALL_NAMES.PLUS,
    isOnUltraTier: false,
    presentUpgradePaywall: async () => ({ purchased: false, cancelled: true }),
  };
}
