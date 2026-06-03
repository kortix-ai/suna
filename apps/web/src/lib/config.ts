import { getEnv } from '@/lib/env-config';

/**
 * Whether billing (Stripe, credit tracking, paywall, plan picker) is enabled on
 * the frontend. Single switch — NEXT_PUBLIC_BILLING_ENABLED — which should
 * mirror the backend's KORTIX_BILLING_INTERNAL_ENABLED. Everything else (auth,
 * sandbox provisioning, projects, accounts) runs the same code path whether
 * billing is on or off.
 */
export const isBillingEnabled = (): boolean => {
  return getEnv().BILLING_ENABLED;
};
