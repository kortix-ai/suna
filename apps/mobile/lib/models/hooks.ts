/**
 * Models API Hooks
 * 
 * Uses unified account state - models are now part of /billing/account-state
 */

import { useAccountState } from '@/lib/billing';
import type { AccountState } from '@/lib/billing/api';
import type { AvailableModelsResponse, Model } from '@/api/types';

// ============================================================================
// Query Keys
// ============================================================================

export const modelKeys = {
  all: ['models'] as const,
  available: () => [...modelKeys.all, 'available'] as const,
};

// ============================================================================
// Available Models Hook - Uses unified account state
// ============================================================================

export function useAvailableModels(options?: { enabled?: boolean }) {
  const { data: accountState, isLoading, error, ...rest } = useAccountState({
    enabled: options?.enabled,
  });
  
  // Transform account state models to match expected Model format
  const modelsData: AvailableModelsResponse | undefined = accountState ? {
    models: (accountState.models || []).map((m): Model => ({
      id: m.id,
      display_name: m.name,
      requires_subscription: !m.allowed, // If not allowed, requires subscription
      is_available: m.allowed,
      context_window: m.context_window,
      capabilities: m.capabilities || [],
      recommended: m.recommended || false,
      priority: m.priority || 0,
    })),
    subscription_tier: accountState.subscription?.tier_key || 'none',
    total_models: accountState.models?.length || 0,
  } : undefined;
  
  return {
    data: modelsData,
    isLoading,
    error,
    ...rest,
  };
}




