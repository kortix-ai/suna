import type { AgentGrant } from '@kortix/db';
import type { BillingState } from './billing/services/billing-state';

// === Billing Types (Router billing service) ===

export interface BillingDeductResult {
  success: boolean;
  cost: number;
  newBalance: number;
  skipped?: boolean;
  reason?: string;
  transactionId?: string;
  error?: string;
  /** The wallet could not answer (infra fault, not a refusal). The caller answers 503. */
  retryable?: boolean;
}

// === Context Types ===

export interface AppContext {
  accountId: string;
  sandboxId?: string;
  keyId?: string;
}

// Context variables set by auth middleware (platform).
// Single source of truth for everything apiKeyAuth / supabaseAuth / combinedAuth
// write onto the Hono context — keep this in sync with middleware/auth.ts.
export interface AuthVariables {
  userId: string;
  userEmail: string;
  accountId?: string;
  authType?: 'supabase' | 'pat' | 'apiKey' | 'service_account' | 'oauth';
  apiKeyType?: 'user' | 'sandbox';
  /** Sign in with Kortix: the OAuth client the `kortix_oat_` token was minted for. */
  oauthClientId?: string;
  /** Sign in with Kortix: scopes granted to the token (`profile`, `email`, `kortix`). */
  oauthScopes?: string[];
  keyId?: string;
  sandboxId?: string;
  /** Set for project-scoped CLI PATs — enforced against the URL :projectId. */
  tokenProjectId?: string;
  /** Set for session-scoped sandbox connector PATs. */
  sessionId?: string;
  /** PAT token identity for the IAM engine (token-as-principal evaluation). */
  iamTokenId?: string;
  /** Per-agent authorization grant — non-null only for agent-session tokens.
   *  Read by assertAgentScope() to gate Kortix CLI/API actions on top of the
   *  user's own role (net = userRole ∩ agentGrant). Null = full access. */
  agentGrant?: AgentGrant | null;
  /** The human an agent-session token acts on behalf of. Null for an
   *  unattended run, a cleared session, or any non-session credential. */
  onBehalfOfUserId?: string | null;
  /** Live impersonation grant id — set only while a platform admin acts as an
   *  account (middleware/impersonation.ts). Its presence means `accountId` is
   *  the TARGET account, not the caller's own. */
  impersonationGrantId?: string;
  /** The REAL platform admin behind an impersonated request. `userId` stays the
   *  same id; this exists so audit rows can carry both identities explicitly. */
  impersonatorUserId?: string;
  /** Platform role, set by requireAdmin on /v1/admin routes. */
  platformRole?: string;
}

// Hono environment type — Variables match exactly what the auth middleware sets.
export type AppEnv = {
  Variables: AuthVariables;
};

// ─── Tier System (Billing) ──────────────────────────────────────────────────

/**
 * The Enterprise features: the four entitlements the Kortix Enterprise License
 * (`ee/LICENSE`) sells. This list is the single source of truth. The plan
 * catalog, the Demo and Licensed states, the self-host license key, the
 * per-account overrides and `requireEntitlement` all derive from it.
 *
 *   sso          SAML SSO provider config, domain verification, group mappings.
 *   scim         SCIM 2.0 directory provisioning (tokens + the /scim/v2 API).
 *   rbac         Custom roles, policies and groups. Built-in roles stay free.
 *   auditAccess  Reading, exporting and streaming the audit log. Recording is
 *                never gated.
 *
 * The gate rule for every Enterprise route (`ee/README.md`): creating or
 * changing Enterprise configuration, and reading the audit log, needs the
 * entitlement (`requireEntitlement` → 402 `entitlement_required`). Reading
 * configuration and removing it never do, so an account whose license ended
 * can see and undo what it set up. SSO sign-in is never gated.
 */
export const ENTERPRISE_FEATURES = ['sso', 'scim', 'rbac', 'auditAccess'] as const;
export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number];
export type EnterpriseEntitlements = Record<EnterpriseFeature, boolean>;

/** Every Enterprise feature set to `value`. */
export function enterpriseEntitlements(value: boolean): EnterpriseEntitlements {
  return { sso: value, scim: value, rbac: value, auditAccess: value };
}

/** The Enterprise features of a larger entitlement record. */
export function pickEnterprise(entitlements: EnterpriseEntitlements): EnterpriseEntitlements {
  const { sso, scim, rbac, auditAccess } = entitlements;
  return { sso, scim, rbac, auditAccess };
}

export interface TierConfig {
  name: string;
  displayName: string;
  /** Fixed monthly allowance (USD). 0 for `credits`, whose amount lives on the account. */
  monthlyCredits: number;
  canPurchaseCredits: boolean;
  models: string[];
  /** Apps an account on this tier may own, and App runtimes it may run at once. */
  appLimit: number;
  /** The Enterprise features this tier unlocks. */
  entitlements: EnterpriseEntitlements;
}

// ─── Account State (API response) ───────────────────────────────────────────

/** A dated grant of a plan (`credit_accounts.trial_*`). */
export interface AccountTrial {
  plan: 'credits' | 'enterprise';
  started_at: string | null;
  ends_at: string;
  /** Whole days until `ends_at`, rounded up; 0 on the last day. */
  days_left: number;
}

/** An Enterprise contract (`kortix.enterprise_contracts`). */
export interface AccountContract {
  id: string;
  /** Annual platform fee, USD. */
  license_usd: number;
  /** Annual credit commitment, USD, granted as one pool per term. */
  term_months: number;
  collection: 'checkout' | 'invoice' | 'manual';
  starts_at: string | null;
  /** End of the current term. Null for an open-ended contract. */
  ends_at: string | null;
  /** True when the term renews on its own (a Stripe subscription not set to cancel). */
  renews: boolean;
}

export interface AccountEnterpriseOffer {
  id: string;
  license_usd: number;
  term_months: number;
  /** `checkout`: a billing manager accepts and pays by card in the app
   *  (`POST /v1/billing/enterprise-offer/checkout`). */
  collection: 'checkout' | 'invoice' | 'manual';
}

export interface AccountAccessGrace {
  reason: 'trial_ended' | 'contract_ended';
  ends_at: string;
}

export interface AccountStateResponse {
  /** Account entitlement, not project readiness: BYOK still requires a connected key. */
  model_access: { managed: boolean; requires_provider_key: boolean };
  credits: {
    total: number;
    daily: number;
    monthly: number;
    /** Next scheduled reset of the expiring credit bucket. */
    expires_at?: string | null;
    extra: number;
    /** Wallet admission only. Project model availability is resolved by /model-picker. */
    can_run: boolean;
    /** Lifetime rollups derived from credit_ledger (see the
     *  apply_credit_ledger_lifetime_rollup trigger). Reporting figures only —
     *  no gate reads them. */
    lifetime_granted: number;
    lifetime_purchased: number;
    lifetime_used: number;
    daily_refresh: {
      enabled: boolean;
      daily_amount: number;
      refresh_interval_hours: number;
      last_refresh: string | null;
      next_refresh_at: string | null;
      seconds_until_refresh: number | null;
    } | null;
  };
  /** The unambiguous billing situation (billing/services/billing-state.ts) —
   *  the SAME state the billing gate admits on. Clients must branch on this,
   *  never on `tier_key` or on `can_run` alone: `can_run: false` means "blocked",
   *  it does NOT mean "no plan". */
  billing_state: BillingState;
  /** True when a Stripe subscription is currently providing service. Distinct
   *  from `subscription.subscription_id`, which stays set after cancellation. */
  has_active_subscription: boolean;
  /**
   * The plan the account BEHAVES as, named the way the product names plans.
   *
   * Distinct from `subscription` on purpose. `subscription.tier_key` is the
   * STORED plan — the plan Stripe sold. This block is the RESOLVED plan: an
   * active admin-issued trial overlays the stored tier
   * (billing/services/resolve-billing.ts), so a trialing account reports the
   * plan its gates actually enforce. `tier.name`,
   * `tier.display_name`, and `tier.entitlements` come from the same
   * resolved view.
   *
   * Optional: additive field, so a client built against the older shape still
   * type-checks. The API always sends it.
   */
  plan?: {
    /** Plan key: 'none' | 'free' | 'credits' | 'enterprise'. */
    key: string;
    family: 'free' | 'credits' | 'enterprise';
    /** Customer-facing name — 'Free' | 'Credits' | 'Enterprise'. */
    label: string;
    /** Qualifier under the label. Null when the plan needs none. */
    sublabel: string | null;
    status: 'current' | 'non_plan';
    /** How the recurring charge is computed. */
    shape: 'none' | 'credits' | 'contract';
    /** Strictly ordered ladder position (0 = no plan). Compare, don't display. */
    rank: number;
    /** Monthly amount of a paid credits plan, in USD (1 credit = $0.01). Null
     *  for free, enterprise and an admin trial. */
    monthly_usd: number | null;
  };
  subscription: {
    /** STORED plan — the plan Stripe sold (legacy keys read as 'credits'). For
     *  the plan the account behaves as (trial applied), read `plan`. */
    tier_key: string;
    tier_display_name: string;
    /** The credits plan's monthly amount the account pays (USD), kept during a trial. */
    monthly_usd: number | null;
    status: string;
    billing_period: 'monthly' | 'yearly' | 'yearly_commitment' | null;
    provider: 'stripe' | 'revenuecat' | 'local';
    subscription_id: string | null;
    current_period_end: number | null;
    cancel_at_period_end: boolean;
    is_cancelled: boolean;
    cancellation_effective_date: string | null;
    has_scheduled_change: boolean;
    scheduled_change: ScheduledChange | null;
    commitment: CommitmentInfo;
    can_purchase_credits: boolean;
  };
  tier: {
    /** RESOLVED plan key — the plan every gate enforces (see `plan`). */
    name: string;
    display_name: string;
    /** STORED plan's recurring credit grant. A trial grants no credits, so this
     *  keeps describing the subscription, not the resolved plan. */
    monthly_credits: number;
    can_purchase_credits: boolean;
    /** The Enterprise features the account may use, which drive the setup
     *  cards and upsells in the UI. `branding` is a plan entitlement, on for
     *  every plan unless an operator turns it off for the account. */
    entitlements: EnterpriseEntitlements & { branding: boolean };
  };
  /** True when a self-host deployment holds a valid Kortix Enterprise license
   *  key (KORTIX_LICENSE_KEY), which turns every enterprise entitlement on
   *  platform-wide. The frontend then hides every Enterprise upsell. */
  enterprise_license_available: boolean;
  /** @deprecated Read `plan.family === 'enterprise'`. True on the Enterprise
   *  plan (a contract or an Enterprise trial). */
  enterprise_entitled: boolean;
  /** The active trial: a dated grant of a plan. Null when there is none. */
  /** @deprecated Trials are removed: always null. */
  trial: AccountTrial | null;
  /** The Enterprise feature layer: off, demo (self-serve) or licensed (a contract). */
  enterprise: { state: 'off' | 'demo' | 'licensed' };
  /** The active Enterprise contract. Null when there is none. */
  contract: AccountContract | null;
  /** An Enterprise contract offered and not yet accepted. Billing managers see
   *  it with an Accept button. Null when there is none. */
  enterprise_offer: AccountEnterpriseOffer | null;
  /** SSO and SCIM stay on after an Enterprise trial or contract ends, until
   *  `ends_at`, so nobody is locked out. Null outside that window. */
  grace: AccountAccessGrace | null;
  /** @deprecated Model gates moved into provider configuration and sandbox model discovery. */
  models: ModelInfo[];
  auto_topup: {
    enabled: boolean;
    threshold: number;
    amount: number;
    /** Why a failed charge turned auto top-up off (KRTX-1718). */
    disabled_reason: string | null;
    /** The decline code or failure text of the last failed charge. */
    last_failure_reason: string | null;
    last_failure_at: string | null;
  };
  /**
   * Spend breakdown by category for the current billing period. Sourced from
   * credit_ledger aggregation, not from a partitioned wallet.
   */
  usage_this_period?: {
    compute_usd: number;
    llm_usd: number;
    total_usd: number;
    period_start: string | null;
    period_end: string | null;
  } | null;
}

export interface ScheduledChange {
  type: 'downgrade';
  /** `monthly_credits` is in credits (1 credit = $0.01); `monthly_usd` is the same amount in USD. */
  current_tier: { name: string; display_name: string; monthly_credits?: number; monthly_usd?: number };
  target_tier: { name: string; display_name: string; monthly_credits?: number; monthly_usd?: number };
  effective_date: string;
}

export interface CommitmentInfo {
  has_commitment: boolean;
  can_cancel: boolean;
  commitment_type: string | null;
  months_remaining: number | null;
  commitment_end_date: string | null;
}

/** @deprecated Legacy model gating — models are now configured in-sandbox via LLM Providers. */
interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  allowed: boolean;
  context_window: number;
  capabilities: string[];
  priority: number;
}

