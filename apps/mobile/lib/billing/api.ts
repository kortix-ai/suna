/**
 * Unified Billing API Client & Types
 *
 * Single endpoint for all billing state
 */

import { API_URL, getAuthHeaders } from '@/api/config';
import { log } from '@/lib/logger';

// =============================================================================
// UNIFIED ACCOUNT STATE
// =============================================================================

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
    is_trial: boolean;
    trial_status: string | null;
    trial_ends_at: string | null;
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
    recommended: boolean;
  }>;
  limits: {
    projects: { current: number; max: number };
    threads: { current: number; max: number };
    concurrent_runs: number;
    custom_workers: number;
    scheduled_triggers: number;
    app_triggers: number;
  };
  tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
    can_purchase_credits: boolean;
  };
  _cache?: {
    cached: boolean;
    ttl_seconds?: number;
    local_mode?: boolean;
  };
}

export interface CancelScheduledChangeResponse {
  success: boolean;
  message: string;
}

// =============================================================================
// API Helper
// =============================================================================

async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeaders();
  const fullUrl = `${API_URL}${endpoint}`;
  log.log('🌐 Fetching:', fullUrl);

  const response = await fetch(fullUrl, {
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));

    // Only log non-auth errors (401/403 are expected when not authenticated)
    if (response.status !== 401 && response.status !== 403) {
      log.error('❌ Billing API Error:', {
        endpoint,
        status: response.status,
        error: errorData,
      });
    }

    const errorMessage =
      errorData.detail?.message || errorData.detail || errorData.message || response.statusText;
    throw new Error(`HTTP ${response.status}: ${errorMessage}`);
  }

  return response.json();
}

// =============================================================================
// API Functions
// =============================================================================

export const billingApi = {
  /**
   * Get unified account state - single source of truth for all billing data
   */
  async getAccountState(skipCache = false): Promise<AccountState> {
    const params = skipCache ? '?skip_cache=true' : '';
    const data = await fetchApi<AccountState>(`/billing/account-state${params}`);
    
    // Log received account state for debugging
    log.log('📊 [AccountState] Received:', JSON.stringify({
      subscription: {
        tier_key: data.subscription?.tier_key,
        tier_display_name: data.subscription?.tier_display_name,
        status: data.subscription?.status,
        provider: data.subscription?.provider,
        billing_period: data.subscription?.billing_period,
        is_trial: data.subscription?.is_trial,
        is_cancelled: data.subscription?.is_cancelled,
        has_scheduled_change: data.subscription?.has_scheduled_change,
        subscription_id: data.subscription?.subscription_id ? '✓' : '✗',
      },
      credits: {
        total: data.credits?.total,
        daily: data.credits?.daily,
        monthly: data.credits?.monthly,
        extra: data.credits?.extra,
        can_run: data.credits?.can_run,
      },
      tier: {
        name: data.tier?.name,
        display_name: data.tier?.display_name,
        monthly_credits: data.tier?.monthly_credits,
      },
      models_count: data.models?.length,
      allowed_models: data.models?.filter(m => m.allowed).map(m => m.id),
      _cache: data._cache,
    }, null, 2));
    
    return data;
  },

  async cancelScheduledChange(): Promise<CancelScheduledChangeResponse> {
    return fetchApi('/billing/cancel-scheduled-change', {
      method: 'POST',
    });
  },

  async getTransactions(limit: number, offset: number): Promise<any> {
    return fetchApi(`/billing/transactions?limit=${limit}&offset=${offset}`);
  },
};
