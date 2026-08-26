// Billing — account-state read (the single source of truth for credits,
// subscription, models, and limits; drives `accountHasAppAccess` and the
// app-access redirect on login) PLUS the checkout/subscription/credits
// mutation surface (Stripe-backed). Wraps a deliberately curated subset of
// apps/api/src/billing/routes — the ones a "Kortix as a Backend" host needs to
// drive billing itself; Stripe-webhook-only routes and legacy/per-seat-claim
// internals stay unwired.

import { backendApi } from '../../http/api-client';
import { serverTokenGet, unwrap, type ServerTokenOptions } from './shared';

/**
 * The unambiguous billing situation for an account — the SAME state the API's
 * billing gate admits on (apps/api/src/billing/services/billing-state.ts).
 *
 * Branch on this, never on `tier_key` (which stays `free` for per-seat Team
 * accounts) and never on `can_run` alone (`false` means BLOCKED, not "no plan").
 */
export type BillingState =
  | 'active'
  | 'out_of_credits'
  | 'no_subscription'
  | 'payment_failed'
  | 'no_account';

/**
 * The public plan ladder. Exactly three rungs — every plan key an account can
 * carry, current or grandfathered, belongs to one of them.
 */
export type PlanFamily = 'free' | 'team' | 'enterprise';

export interface AccountState {
  credits: {
    total: number;
    daily: number;
    monthly: number;
    extra: number;
    can_run: boolean;
    /** Lifetime rollups derived from credit_ledger, server-side. Present once
     *  the API is updated; absent on older responses. */
    lifetime_granted?: number;
    lifetime_purchased?: number;
    lifetime_used?: number;
    daily_refresh: {
      enabled: boolean;
      daily_amount: number;
      refresh_interval_hours: number;
      last_refresh?: string;
      next_refresh_at?: string;
      seconds_until_refresh?: number;
    } | null;
  };
  /** Present once the API is updated; absent → derive client-side. */
  billing_state?: BillingState;
  /** True when a Stripe subscription is currently providing service (distinct
   *  from `subscription.subscription_id`, which survives cancellation). */
  has_active_subscription?: boolean;
  /**
   * The plan the account BEHAVES as, named the way the product names plans.
   *
   * Distinct from `subscription` on purpose. `subscription.tier_key` is the
   * STORED plan — the one Stripe sold. This block is the RESOLVED plan: an
   * active admin-issued trial and the per-seat self-heal overlay it, so it
   * reports the plan the server's gates actually enforce. Read it through
   * {@link resolvedPlan}, which also covers responses from an API too old to
   * send it.
   *
   * Optional: additive on the wire. The API sends it as of the plan-resolver
   * rollout; older deployments omit it entirely.
   */
  plan?: {
    /** Plan key — e.g. 'free', 'per_seat', 'tier_25_200', 'enterprise'. */
    key: string;
    /** Public ladder position: there are exactly three families. */
    family: PlanFamily;
    /** Customer-facing family name — 'Free' | 'Team' | 'Enterprise'. */
    label: string;
    /** Qualifier under the label, e.g. '$200/mo · grandfathered'. Null when
     *  the plan needs no qualifier. */
    sublabel: string | null;
    /** Lifecycle: sellable today, sold-once-and-honored, defined-but-never-sold,
     *  or the absence of a plan. */
    status: 'current' | 'grandfathered' | 'retired' | 'non_plan';
    /** How the recurring charge is computed. */
    shape: 'none' | 'flat' | 'seat' | 'contract';
    /** Strictly ordered ladder position (0 = no plan). Compare, don't display. */
    rank: number;
    /** `status === 'grandfathered'` — sold once, still honored exactly as sold.
     *  Render the plan as it was sold instead of mapping it onto a current plan
     *  it is not. */
    is_grandfathered: boolean;
  };
  subscription: {
    tier_key: string;
    tier_display_name: string;
    status: string;
    billing_period: 'monthly' | 'yearly' | 'yearly_commitment' | null;
    provider: 'stripe' | 'revenuecat' | 'local';
    subscription_id: string | null;
    current_period_end: number | null;
    cancel_at_period_end: boolean;
    is_cancelled: boolean;
    cancellation_effective_date: string | null;
    has_scheduled_change: boolean;
    scheduled_change: {
      type: 'downgrade';
      current_tier: {
        name: string;
        display_name: string;
        monthly_credits?: number;
      };
      target_tier: {
        name: string;
        display_name: string;
        monthly_credits?: number;
      };
      effective_date: string;
    } | null;
    commitment: {
      has_commitment: boolean;
      can_cancel: boolean;
      commitment_type?: string | null;
      months_remaining?: number | null;
      commitment_end_date?: string | null;
    };
    can_purchase_credits: boolean;
  };
  models: Array<{
    id: string;
    name: string;
    provider: string;
    allowed: boolean;
    context_window: number;
    capabilities: string[];
    priority: number;
  }>;
  limits?: {
    concurrent_runs: {
      running_count: number;
      limit: number;
      can_start: boolean;
      tier_name: string;
    };
    ai_worker_count: {
      current_count: number;
      limit: number;
      can_create: boolean;
      tier_name: string;
    };
    custom_mcp_count: {
      current_count: number;
      limit: number;
      can_create: boolean;
      tier_name: string;
    };
    concurrent_sessions?: {
      active: number;
      limit: number;
    };
  };
  tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
    can_purchase_credits: boolean;
    /** Enterprise feature gates for this tier (SSO / SCIM / custom RBAC /
     *  audit log access). Drives whether the account-settings "Identity &
     *  directory" cards render and whether the Groups/Roles/Policies tabs'
     *  create actions are enabled. */
    entitlements?: {
      sso: boolean;
      scim: boolean;
      rbac: boolean;
      auditAccess: boolean;
      /** Organization branding — own logo / icon / favicon / product name. */
      branding: boolean;
    };
  };
  /** True when a self-host operator's ENTERPRISE_LICENSE_AVAILABLE env var
   *  forces every enterprise entitlement on platform-wide — the frontend
   *  hides the self-serve "Enterprise features — Demo" toggle and any
   *  "Request enterprise access" upsell when this is true. */
  enterprise_license_available?: boolean;
  /** True when an operator flagged this account as a contracted cloud
   *  Enterprise customer (`credit_accounts.enterprise_entitled`). The account
   *  then resolves all enterprise entitlements regardless of billing tier, so
   *  a deal that is BOTH Enterprise AND per-seat can hold both at once. The
   *  frontend uses this to hide the self-serve demo toggle (a real contract
   *  supersedes the demo). */
  enterprise_entitled?: boolean;
  auto_topup?: {
    enabled: boolean;
    threshold: number;
    amount: number;
  };
  instances?: Array<{
    sandbox_id: string;
    name: string;
    provider: string;
    status: string;
    server_type: string | null;
    location: string | null;
    is_included: boolean;
    stripe_subscription_id: string | null;
    stripe_subscription_item_id: string | null;
    cancel_at_period_end?: boolean;
    cancel_at?: string | null;
    created_at: string;
  }>;
  can_add_instances?: boolean;
  can_claim_computer?: boolean;
  // Whether the CURRENT user may change billing for this account (billing.write —
  // owners only by default). Drives the "Subscribe" / "Manage billing" CTA gate:
  // members (billing.read only) see a disabled CTA instead of clicking through to
  // a 403. UI hint only — the billing API enforces the same gate server-side.
  // Absent (undefined) is treated as "allowed" so older responses don't block owners.
  can_manage_billing?: boolean;
  // True only for genuine legacy per-machine accounts that have a machine to
  // migrate — gates the "Claim seat-based pricing" card (new per-seat-era users
  // must not see it, or the claim dead-ends on "nothing to switch").
  can_claim_per_seat?: boolean;
  // Billing v2 — present for accounts on the new per-seat plan.
  billing_model?: 'legacy' | 'per_seat';
  seats?: {
    count: number;
    price_per_seat_usd: number;
    typical_compute_budget_per_seat_usd: number;
    typical_llm_budget_per_seat_usd: number;
  };
  // Live account-member count = the seat quantity a per-seat subscribe is billed
  // for right now (server uses the same count for the Stripe line item). Lets the
  // subscribe modal show the real projected total before redirecting to Stripe.
  // Present once the API is updated; absent → fall back to seats.count then 1.
  member_count?: number;
  usage_this_period?: {
    compute_usd: number;
    llm_usd: number;
    total_usd: number;
    period_start: string | null;
    period_end: string | null;
  } | null;
  _cache?: {
    cached: boolean;
    ttl_seconds?: number;
    local_mode?: boolean;
  };
}

export function getDefaultAccountState(): AccountState {
  return {
    credits: {
      total: 0,
      daily: 0,
      monthly: 0,
      extra: 0,
      can_run: false,
      daily_refresh: null,
    },
    subscription: {
      tier_key: 'none',
      tier_display_name: 'No Plan',
      status: 'no_subscription',
      billing_period: null,
      provider: 'stripe',
      subscription_id: null,
      current_period_end: null,
      cancel_at_period_end: false,
      is_cancelled: false,
      cancellation_effective_date: null,
      has_scheduled_change: false,
      scheduled_change: null,
      commitment: {
        has_commitment: false,
        can_cancel: true,
        commitment_type: null,
        months_remaining: null,
        commitment_end_date: null,
      },
      can_purchase_credits: false,
    },
    models: [],
    limits: {
      concurrent_runs: {
        running_count: 0,
        limit: 0,
        can_start: false,
        tier_name: 'none',
      },
      ai_worker_count: {
        current_count: 0,
        limit: 0,
        can_create: false,
        tier_name: 'none',
      },
      custom_mcp_count: {
        current_count: 0,
        limit: 0,
        can_create: false,
        tier_name: 'none',
      },
    },
    tier: {
      name: 'none',
      display_name: 'No Plan',
      monthly_credits: 0,
      can_purchase_credits: false,
    },
  };
}

// ── Plan selectors ──────────────────────────────────────────────────────────

/** What a UI needs to name an account's plan. */
export interface ResolvedPlanView {
  /** Which rung of the public ladder — the only value worth branching on. */
  family: PlanFamily;
  /** Customer-facing plan name, e.g. 'Team'. Never empty. */
  label: string;
  /** Qualifier to render muted after the label, e.g.
   *  '$40/seat/mo · grandfathered'. Null when the plan needs none. */
  sublabel: string | null;
  /** Sold once, still honored exactly as sold, no longer offered. */
  isGrandfathered: boolean;
}

/**
 * Fallback family for an API that predates the `plan` block. `free` and `none`
 * are the only two keys in the free family and `enterprise` is the only key in
 * the enterprise family, so everything else is a Team-family plan — current or
 * grandfathered.
 */
function planFamilyForTierKey(tierKey: string): PlanFamily {
  const key = tierKey.trim().toLowerCase();
  if (key === '' || key === 'free' || key === 'none') return 'free';
  if (key === 'enterprise') return 'enterprise';
  return 'team';
}

/**
 * The plan an account BEHAVES as, as a UI should name it.
 *
 * Prefer this over `state.subscription.tier_key` for anything a person reads or
 * any "is this account on a paid plan?" branch. `tier_key` is the STORED plan,
 * which stays `free` for an account on an admin trial and for a paying per-seat
 * team whose row is stale — branch on it and the UI contradicts the server.
 *
 * Degrades safely: an API too old to send `plan` still yields a family and a
 * label, derived from `tier` / `subscription.tier_key`.
 */
export function resolvedPlan(state: AccountState | null | undefined): ResolvedPlanView {
  const plan = state?.plan;
  if (plan) {
    return {
      family: plan.family,
      label: plan.label,
      sublabel: plan.sublabel ?? null,
      isGrandfathered: plan.is_grandfathered === true,
    };
  }

  // No state at all reads as the default state — 'No Plan', the same name the
  // rest of this module gives the absence of a plan.
  const s = state ?? getDefaultAccountState();
  const tierKey = (s.subscription?.tier_key || s.tier?.name || 'none').toString();
  const label = (s.tier?.display_name || '').trim() || tierKey;
  return {
    family: planFamilyForTierKey(tierKey),
    label,
    // The old shape carries no qualifier and no lifecycle, so there is nothing
    // honest to put here. Guessing "grandfathered" from a `tier_*` key would
    // print a billing claim the response never made.
    sublabel: null,
    isGrandfathered: false,
  };
}

export interface GetAccountStateOptions {
  skipCache?: boolean;
  /** Scope the fetch to a specific account the user is a member of (e.g. on
   *  /accounts/[id] pages). Without it, the backend uses the user's first
   *  membership. */
  accountId?: string;
}

/**
 * Get unified account state — the single source of truth for all billing
 * data (credits, subscription, models, limits). Gracefully degrades to a
 * default "no plan" shape when billing is disabled or the caller is
 * unauthenticated, so callers never have to special-case those responses.
 */
export async function getAccountState(options?: GetAccountStateOptions): Promise<AccountState> {
  const search = new URLSearchParams();
  if (options?.skipCache) search.set('skip_cache', 'true');
  if (options?.accountId) search.set('account_id', options.accountId);
  const query = search.toString();
  const params = query ? `?${query}` : '';
  const response = await backendApi.get<AccountState>(`/billing/account-state${params}`, {
    showErrors: false,
  });
  const isGracefulDisabledResponse =
    response.error?.status === 404 && /billing is not enabled/i.test(response.error.message || '');
  if (response.error && response.error.status !== 401 && !isGracefulDisabledResponse) {
    throw response.error;
  }
  if (response.error) {
    return getDefaultAccountState();
  }
  return response.data!;
}

/**
 * Minimal variant of {@link getAccountState} (`/billing/account-state/minimal`)
 * — same response shape (`AccountState`), a cheaper server-side build for
 * surfaces that only need a subset (e.g. a header credit indicator). Same
 * graceful-degradation behavior as the full read.
 */
export async function getAccountStateMinimal(options?: GetAccountStateOptions): Promise<AccountState> {
  const search = new URLSearchParams();
  if (options?.skipCache) search.set('skip_cache', 'true');
  if (options?.accountId) search.set('account_id', options.accountId);
  const query = search.toString();
  const params = query ? `?${query}` : '';
  const response = await backendApi.get<AccountState>(`/billing/account-state/minimal${params}`, {
    showErrors: false,
  });
  const isGracefulDisabledResponse =
    response.error?.status === 404 && /billing is not enabled/i.test(response.error.message || '');
  if (response.error && response.error.status !== 401 && !isGracefulDisabledResponse) {
    throw response.error;
  }
  if (response.error) {
    return getDefaultAccountState();
  }
  return response.data!;
}

// ── Transactions / credit ledger ─────────────────────────────────────────────

export interface BillingTransaction {
  id: string;
  created_at: string;
  amount: number;
  balance_after: number;
  type: string;
  description: string | null;
  is_expiring: boolean | null;
  expires_at: string | null;
  metadata: unknown;
}

export interface BillingTransactionsPage {
  transactions: BillingTransaction[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

export interface ListBillingTransactionsOptions {
  accountId?: string;
  limit?: number;
  offset?: number;
  /** A single type, or several (comma-joined on the wire). */
  typeFilter?: string | string[];
}

export async function listBillingTransactions(
  options?: ListBillingTransactionsOptions,
): Promise<BillingTransactionsPage> {
  const search = new URLSearchParams();
  if (options?.accountId) search.set('account_id', options.accountId);
  if (options?.limit != null) search.set('limit', String(options.limit));
  if (options?.offset != null) search.set('offset', String(options.offset));
  if (options?.typeFilter) {
    search.set(
      'type_filter',
      Array.isArray(options.typeFilter) ? options.typeFilter.join(',') : options.typeFilter,
    );
  }
  const query = search.toString();
  return unwrap(
    await backendApi.get<BillingTransactionsPage>(`/billing/transactions${query ? `?${query}` : ''}`),
  );
}

/** Credits-in / credits-out totals over a trailing window of days (default 30). */
export interface BillingTransactionsSummary {
  totalCredits: number;
  totalDebits: number;
  count: number;
}

export async function getBillingTransactionsSummary(options?: {
  accountId?: string;
  days?: number;
}): Promise<BillingTransactionsSummary> {
  const search = new URLSearchParams();
  if (options?.accountId) search.set('account_id', options.accountId);
  if (options?.days != null) search.set('days', String(options.days));
  const query = search.toString();
  return unwrap(
    await backendApi.get<BillingTransactionsSummary>(
      `/billing/transactions/summary${query ? `?${query}` : ''}`,
    ),
  );
}

// ── Credits / tiers ───────────────────────────────────────────────────────────

export interface BillingCreditBreakdown {
  total: number;
  expiring: number;
  non_expiring: number;
  daily: number;
}

/** Balance breakdown for the CALLER's own account (no `accountId` scoping —
 *  the backend keys this read off the authenticated user directly). */
export async function getBillingCreditBreakdown(): Promise<BillingCreditBreakdown> {
  return unwrap(await backendApi.get<BillingCreditBreakdown>('/billing/credit-breakdown'));
}

/**
 * Credit usage summary over a trailing window of days (default 30) — same
 * shape as {@link getBillingTransactionsSummary}, but for the CALLER's own
 * account (no `accountId` scoping).
 */
export async function getBillingUsageHistory(days?: number): Promise<BillingTransactionsSummary> {
  const qs = days != null ? `?days=${days}` : '';
  return unwrap(await backendApi.get<BillingTransactionsSummary>(`/billing/usage-history${qs}`));
}

export interface BillingTierConfiguration {
  tier_key?: string;
  name: string;
  display_name: string;
  monthly_price: number;
  yearly_price: number;
  monthly_credits: number;
  can_purchase_credits: boolean;
  project_limit?: number;
  price_ids?: string[];
}

export interface BillingTierConfigurationsResponse {
  success?: boolean;
  tiers: BillingTierConfiguration[];
  timestamp?: string;
}

/** Publicly visible pricing tiers (for a plans/pricing page). */
export async function getBillingTierConfigurations(): Promise<BillingTierConfigurationsResponse> {
  return unwrap(
    await backendApi.get<BillingTierConfigurationsResponse>('/billing/tier-configurations'),
  );
}

// ── Server-side explicit-token variant ──────────────────────────────────────

/**
 * Minimal projection of {@link AccountState} needed for server-side app-access
 * gating (`accountHasAppAccess`). The full `AccountState` shape is large and
 * product-UI-specific; server actions/route handlers only ever need this
 * slice before redirecting a freshly-authenticated user.
 */
export interface AccountStateAppAccessView {
  /** The RESOLVED plan key — authoritative over `subscription.tier_key`, which
   *  is the STORED plan and stays `free` for an account on an admin trial.
   *  Optional: an API older than the plan resolver omits the block. */
  plan?: { key?: string | null } | null;
  subscription?: { tier_key?: string | null } | null;
  tier?: { name?: string | null } | null;
  credits?: { can_run?: boolean | null } | null;
}

export interface FetchAccountStateWithTokenOptions extends ServerTokenOptions {
  accountId?: string;
}

/**
 * Server-side / explicit-token variant of {@link getAccountState}, for
 * Next.js server actions and route handlers (login redirect, auth callback)
 * that already resolved the caller's Supabase access token and run before
 * (or without relying on) the SDK's ambient `configureKortix()` seam. Returns
 * `null` on any failure — callers treat that as "can't tell yet" and fall
 * through to their default destination.
 */
export async function fetchAccountStateWithToken(
  opts: FetchAccountStateWithTokenOptions,
): Promise<AccountStateAppAccessView | null> {
  const query = opts.accountId ? `?account_id=${encodeURIComponent(opts.accountId)}` : '';
  return serverTokenGet<AccountStateAppAccessView>(opts, `/v1/billing/account-state${query}`);
}

// ── Checkout / subscription / credits mutations ─────────────────────────────
//
// All bodies accept an optional `account_id` (the backend falls back to the
// caller's own account when omitted) plus opaque Stripe-service fields the
// server forwards mostly as-is — responses are intentionally loose
// (`Record<string, unknown>`-ish) since the server schemas are opaque
// (`z.record(...)`) on purpose.

export interface CreateCheckoutSessionInput {
  accountId?: string;
  tierKey: string;
  successUrl: string;
  cancelUrl: string;
  commitmentType?: string;
  locale?: string;
  serverType?: string;
  location?: string;
}

export interface CheckoutSessionResult {
  url?: string | null;
  checkout_url?: string;
  session_id?: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

/** Create a Stripe checkout session for a subscription tier. */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  return unwrap(
    await backendApi.post<CheckoutSessionResult>('/billing/create-checkout-session', {
      account_id: input.accountId,
      tier_key: input.tierKey,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      commitment_type: input.commitmentType,
      locale: input.locale,
      server_type: input.serverType,
      location: input.location,
    }),
    'Failed to create checkout session',
  );
}

export interface ConfirmCheckoutSessionResult {
  ok?: boolean;
  [key: string]: unknown;
}

/** Confirm a completed Stripe checkout session (post-redirect). */
export async function confirmCheckoutSession(
  sessionId: string,
  accountId?: string,
): Promise<ConfirmCheckoutSessionResult> {
  return unwrap(
    await backendApi.post<ConfirmCheckoutSessionResult>('/billing/confirm-checkout-session', {
      account_id: accountId,
      session_id: sessionId,
    }),
    'Failed to confirm checkout session',
  );
}

export interface PortalSessionResult {
  url?: string | null;
  [key: string]: unknown;
}

/** Create a Stripe customer-portal session (manage payment method / invoices / cancel). */
export async function createPortalSession(
  returnUrl: string,
  accountId?: string,
): Promise<PortalSessionResult> {
  return unwrap(
    await backendApi.post<PortalSessionResult>('/billing/create-portal-session', {
      account_id: accountId,
      return_url: returnUrl,
    }),
    'Failed to create portal session',
  );
}

export interface SubscriptionMutationResult {
  ok?: boolean;
  success: boolean;
  message: string;
  [key: string]: unknown;
}

/** Cancel the active subscription (optionally recording cancellation feedback). */
export async function cancelSubscription(
  feedback?: string,
  accountId?: string,
): Promise<SubscriptionMutationResult> {
  return unwrap(
    await backendApi.post<SubscriptionMutationResult>('/billing/cancel-subscription', {
      account_id: accountId,
      feedback,
    }),
    'Failed to cancel subscription',
  );
}

/** Reactivate a subscription that was scheduled for cancellation. */
export async function reactivateSubscription(accountId?: string): Promise<SubscriptionMutationResult> {
  return unwrap(
    await backendApi.post<SubscriptionMutationResult>('/billing/reactivate-subscription', {
      account_id: accountId,
    }),
    'Failed to reactivate subscription',
  );
}

/** Schedule a downgrade to a lower tier, effective at the current period end. */
export async function scheduleDowngrade(
  targetTierKey: string,
  commitmentType?: string,
  accountId?: string,
): Promise<SubscriptionMutationResult> {
  return unwrap(
    await backendApi.post<SubscriptionMutationResult>('/billing/schedule-downgrade', {
      account_id: accountId,
      target_tier_key: targetTierKey,
      commitment_type: commitmentType,
    }),
    'Failed to schedule downgrade',
  );
}

/** Cancel a previously scheduled downgrade/plan change. */
export async function cancelScheduledChange(accountId?: string): Promise<SubscriptionMutationResult> {
  return unwrap(
    await backendApi.post<SubscriptionMutationResult>('/billing/cancel-scheduled-change', {
      account_id: accountId,
    }),
    'Failed to cancel scheduled change',
  );
}

export interface ProrationPreviewResult {
  [key: string]: unknown;
}

/** Preview proration for a price change (new Stripe price id) before committing to it. */
export async function getProrationPreview(
  newPriceId: string,
  accountId?: string,
): Promise<ProrationPreviewResult> {
  const search = new URLSearchParams({ new_price_id: newPriceId });
  if (accountId) search.set('account_id', accountId);
  return unwrap(
    await backendApi.get<ProrationPreviewResult>(`/billing/proration-preview?${search.toString()}`),
    'Failed to load proration preview',
  );
}

export interface PurchaseCreditsInput {
  amount: number;
  accountId?: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface PurchaseCreditsResult {
  checkout_url: string | null;
}

/** Create a Stripe checkout session to purchase a one-off credit top-up. */
export async function purchaseCredits(input: PurchaseCreditsInput): Promise<PurchaseCreditsResult> {
  return unwrap(
    await backendApi.post<PurchaseCreditsResult>('/billing/purchase-credits', {
      amount: input.amount,
      account_id: input.accountId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }),
    'Failed to purchase credits',
  );
}

export interface AutoTopupSettings {
  enabled: boolean;
  threshold: number;
  amount: number;
  [key: string]: unknown;
}

/** Get the account's auto-topup settings (enabled/threshold/amount). */
export async function getAutoTopupSettings(accountId?: string): Promise<AutoTopupSettings> {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(
    await backendApi.get<AutoTopupSettings>(`/billing/auto-topup/settings${query}`),
    'Failed to load auto-topup settings',
  );
}

export interface ConfigureAutoTopupInput {
  accountId?: string;
  enabled: boolean;
  threshold: number;
  amount: number;
}

/**
 * Configure (enable/disable, threshold, amount) auto-topup — recurring credit
 * purchases.
 *
 * `showErrors: false` — the single caller (`AutoTopupCard.handleSave`) already
 * shows its own `errorToast` from the thrown error in its `catch` block. Without
 * this, the SDK's global `onError` (wired to `handleApiError` in
 * `apps/web/src/lib/kortix-config.ts`) ALSO toasted the same message, so one
 * failed Save produced two stacked identical toasts.
 */
export async function configureAutoTopup(input: ConfigureAutoTopupInput): Promise<AutoTopupSettings> {
  return unwrap(
    await backendApi.post<AutoTopupSettings>(
      '/billing/auto-topup/configure',
      {
        account_id: input.accountId,
        enabled: input.enabled,
        threshold: input.threshold,
        amount: input.amount,
      },
      { showErrors: false },
    ),
    'Failed to configure auto-topup',
  );
}

export interface AutoTopupSetupStatus {
  /** A chargeable saved payment method exists — of ANY type (card, Link, SEPA…).
   *  This is the field that gates enabling auto top-up. */
  has_payment_method: boolean;
  /** Informational: a method is designated default at the customer or
   *  subscription level. Never gate the UI on this — a Stripe Link checkout
   *  leaves the customer-level invoice default null while still having a
   *  perfectly chargeable method. */
  has_default_payment_method: boolean;
  payment_method_source?: 'customer_default' | 'subscription_default' | 'attached' | null;
}

export async function getAutoTopupSetupStatus(accountId?: string): Promise<AutoTopupSetupStatus> {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(
    await backendApi.get<AutoTopupSetupStatus>(`/billing/auto-topup/setup-status${query}`, {
      timeout: 8000,
      showErrors: false,
    }),
    'Failed to load auto-topup setup status',
  );
}

export interface CreatePerSeatCheckoutInput {
  accountId?: string;
  successUrl: string;
  cancelUrl: string;
  locale?: string;
}

export interface CreatePerSeatCheckoutResult {
  status: 'subscription_created' | 'checkout_created';
  checkout_url?: string;
  subscription_id?: string;
  seat_count: number;
}

export async function createPerSeatCheckout(
  input: CreatePerSeatCheckoutInput,
): Promise<CreatePerSeatCheckoutResult> {
  return unwrap(
    await backendApi.post<CreatePerSeatCheckoutResult>('/billing/create-per-seat-checkout', {
      account_id: input.accountId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      locale: input.locale,
    }),
    'Failed to create per-seat checkout',
  );
}

export interface ClaimPerSeatResult {
  ok: boolean;
  status: string;
  credited_usd: number;
  first_seat_covered_usd: number;
  cancelled_subscriptions: number;
  reason?: string | null;
}

export async function claimPerSeatBilling(accountId?: string): Promise<ClaimPerSeatResult> {
  return unwrap(
    await backendApi.post<ClaimPerSeatResult>('/billing/claim-per-seat', {
      account_id: accountId,
    }),
    'Failed to switch to per-seat billing',
  );
}

export async function syncSubscription(accountId?: string): Promise<SubscriptionMutationResult> {
  return unwrap(
    await backendApi.post<SubscriptionMutationResult>('/billing/sync-subscription', {
      account_id: accountId,
    }),
    'Failed to sync subscription',
  );
}

// ── Usage rollup (/v1/usage) ──────────────────────────────────────────────────

export interface UsageTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_cache_write_tokens: number;
  total_cost: number;
  count: number;
}

export interface UsageBreakdownItem {
  day?: string;
  provider?: string | null;
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cost: number;
  count: number;
}

export interface UsageRollup {
  data: UsageTotals;
  breakdown?: UsageBreakdownItem[];
}

export interface UsageQueryOptions {
  start?: string;
  end?: string;
  groupBy?: 'model' | 'provider' | 'day';
  /**
   * Which account to report on. REQUIRED whenever the caller could be looking at
   * an account other than their default: for a browser session the server reads
   * this from the query string, so omitting it silently reports the caller's own
   * account instead of the one on screen. (Account-scoped tokens ignore it and
   * always report their own account.)
   */
  accountId?: string;
}

/** Usage rollup for the authenticated account, optionally grouped and narrowed. */
export async function getUsageRollup(options: UsageQueryOptions = {}): Promise<UsageRollup> {
  const qs = new URLSearchParams();
  if (options.start) qs.set('start', options.start);
  if (options.end) qs.set('end', options.end);
  if (
    options.groupBy === 'model' ||
    options.groupBy === 'provider' ||
    options.groupBy === 'day'
  ) {
    qs.set('group_by', options.groupBy);
  }
  if (options.accountId) qs.set('account_id', options.accountId);
  const query = qs.toString();
  return unwrap(await backendApi.get<UsageRollup>(`/usage${query ? `?${query}` : ''}`));
}
