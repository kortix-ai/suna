import { z } from 'zod';
import type { AgentGrant } from '@kortix/db';

// === Request Schemas (Router) ===

export const WebSearchRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  max_results: z.number().int().min(1).max(10).default(5),
  search_depth: z.enum(['basic', 'advanced']).default('basic'),
  session_id: z.string().optional(),
});

export const ImageSearchRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  max_results: z.number().int().min(1).max(20).default(5),
  safe_search: z.boolean().default(true),
  session_id: z.string().optional(),
});

// === Response Types (Router) ===

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published_date: string | null;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  query: string;
  cost: number;
}

export interface ImageSearchResult {
  title: string;
  url: string;
  thumbnail_url: string;
  source_url: string;
  width: number | null;
  height: number | null;
}

export interface ImageSearchResponse {
  results: ImageSearchResult[];
  query: string;
  cost: number;
}

// === Billing Types (Router billing service) ===

export interface BillingCheckResult {
  hasCredits: boolean;
  message: string;
  balance: number | null;
}

export interface BillingDeductResult {
  success: boolean;
  cost: number;
  newBalance: number;
  skipped?: boolean;
  reason?: string;
  transactionId?: string;
  error?: string;
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
  authType?: 'supabase' | 'pat' | 'apiKey' | 'service_account';
  apiKeyType?: 'user' | 'sandbox';
  keyId?: string;
  sandboxId?: string;
  /** Set for project-scoped CLI PATs — enforced against the URL :projectId. */
  tokenProjectId?: string;
  /** Set for session-scoped sandbox executor PATs. */
  sessionId?: string;
  /** PAT token identity for the IAM engine (token-as-principal evaluation). */
  iamTokenId?: string;
  /** Per-agent authorization grant — non-null only for agent-session tokens.
   *  Read by assertAgentScope() to gate Kortix CLI/API actions on top of the
   *  user's own role (net = userRole ∩ agentGrant). Null = full access. */
  agentGrant?: AgentGrant | null;
}

// Hono environment type — Variables match exactly what the auth middleware sets.
export type AppEnv = {
  Variables: AuthVariables;
};

// ─── Tier System (Billing) ──────────────────────────────────────────────────

/**
 * Enterprise feature gates, keyed by tier. These unlock the identity/governance
 * surfaces that only Enterprise (sales-assigned) accounts get. A self-serve
 * tier (Free / Team) has every flag `false`; the `enterprise` tier has them all
 * `true`. Enforced server-side in the SCIM / SSO routes + the /scim/v2 data
 * plane, and surfaced on the account-state `tier` block so the UI can hide the
 * setup cards for non-entitled accounts. Add a key here, set it per tier in
 * billing/services/tiers.ts, then guard the relevant route with
 * `requireEntitlement(c, accountId, '<key>')`.
 */
export interface TierEntitlements {
  /** SAML SSO provider config + JIT provisioning + group-claim mapping. */
  sso: boolean;
  /** SCIM 2.0 directory provisioning (token mint/revoke + /scim/v2 endpoints). */
  scim: boolean;
  /**
   * Custom RBAC: user-defined roles, fine-grained policy bindings, and groups
   * (IAM v1 — custom-roles.ts + groups.ts). Built-in preset roles (owner/admin/
   * member/manager/editor/user) stay free on every tier — this only gates the
   * ability to define custom roles/policies/groups beyond those presets.
   */
  rbac: boolean;
  /**
   * Read/export access to the audit trail (account audit log + per-session
   * agent-action audit) and audit-webhook streaming. Recording is NEVER gated —
   * every tier's actions are always captured; this only gates who can read,
   * export, or stream them out.
   */
  auditAccess: boolean;
}

export interface TierConfig {
  name: string;
  displayName: string;
  monthlyPrice: number;
  yearlyPrice: number;
  monthlyCredits: number;
  canPurchaseCredits: boolean;
  models: string[];
  dailyCreditConfig: DailyCreditConfig | null;
  hidden: boolean;
  /** Max concurrent project sessions allowed for accounts on this tier. */
  concurrentSessionLimit: number;
  /** Enterprise feature gates. Absent ⇒ treated as all-false. */
  entitlements: TierEntitlements;
}

export interface DailyCreditConfig {
  dailyAmount: number;
  refreshIntervalHours: number;
  maxAccumulation: number;
}

// ─── Account State (API response) ───────────────────────────────────────────

export interface AccountStateResponse {
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
      last_refresh: string | null;
      next_refresh_at: string | null;
      seconds_until_refresh: number | null;
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
    scheduled_change: ScheduledChange | null;
    commitment: CommitmentInfo;
    can_purchase_credits: boolean;
  };
  tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
    can_purchase_credits: boolean;
    /** Enterprise feature gates for this tier — drives whether the UI shows
     *  the SSO / SCIM setup cards. */
    entitlements: TierEntitlements;
  };
  /** @deprecated Model gates moved into provider configuration and sandbox model discovery. */
  models: ModelInfo[];
  auto_topup: {
    enabled: boolean;
    threshold: number;
    amount: number;
  };
  instances: Array<{
    sandbox_id: string;
    external_id: string | null;
    name: string;
    provider: string;
    status: string;
    server_type: string | null;
    location: string | null;
    error_message?: string | null;
    is_included: boolean;
    stripe_subscription_item_id: string | null;
    created_at: string;
  }>;
  can_add_instances: boolean;
  /** True when a legacy paid user has no active machine and can claim one. */
  can_claim_computer?: boolean;
  /** True only for genuine legacy per-machine accounts with a machine to migrate
   *  to per-seat — gates the "Claim seat-based pricing" card so new per-seat-era
   *  users never see a no-op claim. */
  can_claim_per_seat?: boolean;

  // Billing v2 — surfaced for per-seat accounts only. Legacy accounts get
  // billing_model='legacy' here and the frontend renders the legacy UI.
  billing_model: 'legacy' | 'per_seat';
  seats?: {
    count: number;
    price_per_seat_usd: number;
    /** Pricing-page transparency only — not a wallet partition. */
    typical_compute_budget_per_seat_usd: number;
    /** Pricing-page transparency only — not a wallet partition. */
    typical_llm_budget_per_seat_usd: number;
  };
  /**
   * Live count of account members — the seat quantity a per-seat subscribe will
   * be billed for RIGHT NOW (createPerSeatCheckoutSession uses the same
   * countActiveMembers). Always present (unlike `seats`, which only appears once
   * the account is already on per-seat), so the subscribe modal can show the real
   * projected total (members × price) BEFORE redirecting to Stripe.
   */
  member_count: number;
  /**
   * Spend breakdown by category for the current billing period. Sourced from
   * credit_ledger aggregation, not from a partitioned wallet. Null for legacy
   * accounts.
   */
  usage_this_period?: {
    compute_usd: number;
    llm_usd: number;
    total_usd: number;
    period_start: string | null;
    period_end: string | null;
  } | null;
  /**
   * Account-level resource limits + current usage. The `concurrent_sessions`
   * field surfaces the same cap the API enforces at session-create time
   * (see shared/account-limits.ts).
   */
  limits?: {
    concurrent_sessions: {
      active: number;
      limit: number;
    };
  };
}

export interface ScheduledChange {
  type: 'downgrade';
  current_tier: { name: string; display_name: string; monthly_credits?: number };
  target_tier: { name: string; display_name: string; monthly_credits?: number };
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

export interface TokenUsageRequest {
  prompt_tokens: number;
  completion_tokens: number;
  model: string;
}
