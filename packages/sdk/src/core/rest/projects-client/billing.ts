// Billing — account-state read (the single source of truth for credits,
// subscription, models, and limits; drives `accountHasAppAccess` and the
// app-access redirect on login) PLUS the checkout/subscription/credits
// mutation surface (Stripe-backed). Wraps a deliberately curated subset of
// apps/api/src/billing/routes — the ones a "Kortix as a Backend" host needs to
// drive billing itself; Stripe-webhook-only routes and legacy/per-seat-claim
// internals stay unwired.

import { backendApi } from '../../http/api-client';
import { serverTokenGet, unwrap, type ServerTokenOptions } from './shared';

export interface AccountState {
  credits: {
    total: number;
    daily: number;
    monthly: number;
    extra: number;
    can_run: boolean;
    daily_refresh: {
      enabled: boolean;
      daily_amount: number;
      refresh_interval_hours: number;
      last_refresh?: string;
      next_refresh_at?: string;
      seconds_until_refresh?: number;
    } | null;
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
    };
  };
  /** True when a self-host operator's ENTERPRISE_LICENSE_AVAILABLE env var
   *  forces every enterprise entitlement on platform-wide — the frontend
   *  hides the self-serve "Enterprise features — Demo" toggle and any
   *  "Request enterprise access" upsell when this is true. */
  enterprise_license_available?: boolean;
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
  name: string;
  display_name: string;
  monthly_price: number;
  yearly_price: number;
  monthly_credits: number;
  can_purchase_credits: boolean;
}

export interface BillingTierConfigurationsResponse {
  tiers: BillingTierConfiguration[];
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
  session_id?: string;
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

/** Configure (enable/disable, threshold, amount) auto-topup — recurring credit purchases. */
export async function configureAutoTopup(input: ConfigureAutoTopupInput): Promise<AutoTopupSettings> {
  return unwrap(
    await backendApi.post<AutoTopupSettings>('/billing/auto-topup/configure', {
      account_id: input.accountId,
      enabled: input.enabled,
      threshold: input.threshold,
      amount: input.amount,
    }),
    'Failed to configure auto-topup',
  );
}
