// Billing account-state — the single source of truth for credits,
// subscription, models, and limits. This is the entitlement-gating read: it
// drives `accountHasAppAccess` and the app-access redirect on login. Stripe
// checkout/portal/credits/auto-topup mutations are product-UI and stay
// web-local (apps/web/src/lib/api/billing.ts) — only the account-state read
// (and its server-side explicit-token variant) lives here.

import { backendApi } from '../api-client';
import { serverTokenGet, type ServerTokenOptions } from './shared';

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
