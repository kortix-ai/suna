import { getEnv } from '@/lib/env-config';

/**
 * Deployment feature switches for `apps/web`.
 *
 * NO TIER / PLAN DATA LIVES HERE. This file used to carry a hand-maintained
 * `SUBSCRIPTION_TIERS` catalog (FREE_TIER, PRO, TIER_2_20 … TIER_200_1000 with
 * prices baked into display names). Every one of those tiers is retired, the
 * catalog had zero importers, and the API is the only source of truth for what
 * an account is on. Read plan identity from `resolvedPlan(accountState)` and
 * plan numbers from `accountState.tier` / `accountState.plan` — never from a
 * frontend constant.
 */

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

/**
 * Whether dosco's own managed model lineup ("Managed · Included with your
 * plan" — Claude, GLM, and DeepSeek routed through dosco's shared Bedrock,
 * AsterLab, and OpenRouter credentials) can appear anywhere in the UI.
 * CLOUD-ONLY: mirrors
 * the backend's KORTIX_MANAGED_PROVIDER_ENABLED, which already keeps managed
 * models out of the served model catalog when off. Use this for a surface
 * that reasons about "is `kortix` connected" independently of the live
 * catalog (so it hides the managed entry outright instead of rendering it
 * with zero models) — most surfaces need no extra check since the catalog
 * itself is already empty of managed models on a self-host.
 */
export const isManagedProviderEnabled = (): boolean => {
  return getEnv().MANAGED_PROVIDER_ENABLED;
};

/**
 * Whether Pipedream-backed connector UI (the "Connect your tools" onboarding
 * step, the "Easy connect" app catalogue) is enabled. Cloud always has
 * Pipedream configured (defaults true); self-host without PIPEDREAM_client
 * credentials set should flip NEXT_PUBLIC_CONNECTORS_ENABLED to 'false' so
 * those surfaces don't dead-end in a 501. Custom connectors (OpenAPI/
 * GraphQL/MCP/HTTP) and Slack/email channels are unaffected — they don't
 * depend on Pipedream.
 */
export const isConnectorsEnabled = (): boolean => {
  return getEnv().CONNECTORS_ENABLED;
};

/**
 * Whether creating an ADDITIONAL/org account is restricted to platform
 * admins on this deployment. Mirrors the backend's
 * KORTIX_RESTRICT_ACCOUNT_CREATION (which 403s POST /v1/accounts for
 * non-admins) — this is a UI convenience so ordinary users don't even see a
 * "New account" affordance they can't use; the backend gate is authoritative
 * regardless of what the UI hides. Signups, existing teams, and SSO/JIT
 * membership are entirely unaffected by this flag — only spinning up a
 * brand-new organization is gated. Off by default (cloud); self-host
 * defaults it on. Callers should still check platform-admin status (e.g.
 * `useAdminRole()`) before hiding "New account" UI, since admins are exempt
 * from the restriction.
 */
export const isAccountCreationRestricted = (): boolean => {
  return getEnv().RESTRICT_ACCOUNT_CREATION;
};
