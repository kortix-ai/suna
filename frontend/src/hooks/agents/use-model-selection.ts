'use client';

import { useModelStore } from '@/stores/model-store';
import { useEffect, useMemo, useRef } from 'react';
import { useAccountState } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';

export interface ModelOption {
  id: string;
  label: string;
  requiresSubscription: boolean;
  description?: string;
  priority?: number;
  recommended?: boolean;
  capabilities?: string[];
  contextWindow?: number;
}

// Helper to check if user has a PAID subscription (not free tier)
const isPaidTier = (tierKey: string | undefined): boolean => {
  if (!tierKey) return false;
  return tierKey !== 'free' && tierKey !== 'none';
};

const getDefaultModel = (accessibleModels: ModelOption[]): string => {
  // Pick the first accessible model (sorted by priority)
  // kortix/basic should be first for free users since power is not accessible
  const basicModel = accessibleModels.find(m => m.id === 'kortix/basic');
  if (basicModel) return basicModel.id;
  
  const powerModel = accessibleModels.find(m => m.id === 'kortix/power');
  if (powerModel) return powerModel.id;
  
  // Fallback: pick from accessible models sorted by priority
  if (accessibleModels.length > 0) {
    return accessibleModels[0].id;
  }

  return '';
};

export const useModelSelection = () => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  // Get account state which includes models
  const { data: accountState, isLoading } = useAccountState({ 
    enabled: !!user && !isAuthLoading 
  });

  const { selectedModel, setSelectedModel } = useModelStore();
  
  // Track previous tier to detect upgrades
  const prevTierKey = useRef<string | null>(null);

  // Check if user has paid subscription based on tier_key (not status!)
  const hasPaidSubscription = useMemo(() => {
    return isPaidTier(accountState?.subscription.tier_key);
  }, [accountState?.subscription.tier_key]);

  // Transform API data to ModelOption format
  // The backend's `allowed` field is the source of truth!
  const availableModels = useMemo<ModelOption[]>(() => {
    if (!accountState?.models) return [];
    
    return accountState.models.map(model => ({
      id: model.id,
      label: model.name,
      requiresSubscription: !model.allowed, // Backend already computed this correctly
      priority: model.priority || 0,
      recommended: model.recommended || false,
      capabilities: model.capabilities || [],
      contextWindow: model.context_window || 128000,
    })).sort((a, b) => {
      // Sort accessible models first, then by priority
      if (a.requiresSubscription !== b.requiresSubscription) {
        return a.requiresSubscription ? 1 : -1;
      }
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.label.localeCompare(b.label);
    });
  }, [accountState?.models]);

  // Get accessible models - use the backend's `allowed` field directly!
  const accessibleModels = useMemo(() => {
    return availableModels.filter(model => !model.requiresSubscription);
  }, [availableModels]);

  // Initialize selected model when data loads
  useEffect(() => {
    if (isLoading || !accessibleModels.length) return;

    // If no model selected or selected model is not accessible, set a default
    const needsUpdate = !selectedModel || 
                        !accessibleModels.some(m => m.id === selectedModel);
    
    if (needsUpdate) {
      const defaultModelId = getDefaultModel(accessibleModels);
      
      if (defaultModelId && defaultModelId !== selectedModel) {
        console.log('🔧 useModelSelection: Setting default model:', defaultModelId, '(tier:', accountState?.subscription.tier_key, ')');
        setSelectedModel(defaultModelId);
      }
    }
  }, [selectedModel, accessibleModels, isLoading, setSelectedModel, accountState?.subscription.tier_key]);

  // Auto-switch to Power mode when user upgrades to paid tier
  useEffect(() => {
    if (isLoading || !availableModels.length) return;
    
    const currentTier = accountState?.subscription.tier_key;
    const wasFree = prevTierKey.current === 'free' || prevTierKey.current === 'none';
    const isNowPaid = isPaidTier(currentTier);
    
    // Detect upgrade: was free, now paid
    if (wasFree && isNowPaid && prevTierKey.current !== null) {
      // Check if power model is now accessible
      const powerModel = availableModels.find(m => m.id === 'kortix/power' && !m.requiresSubscription);
      if (powerModel) {
        console.log('🚀 useModelSelection: Upgraded to paid tier! Switching to kortix/power');
        setSelectedModel('kortix/power');
      }
    }
    
    // Update ref for next comparison
    prevTierKey.current = currentTier || null;
  }, [accountState?.subscription.tier_key, availableModels, isLoading, setSelectedModel]);

  const handleModelChange = (modelId: string) => {
    const model = accessibleModels.find(m => m.id === modelId);
    if (model) {
      console.log('🔧 useModelSelection: Changing model to:', modelId);
      setSelectedModel(modelId);
    }
  };

  // subscriptionStatus for UI purposes - based on tier, not status
  const subscriptionStatus = hasPaidSubscription ? 'active' as const : 'no_subscription' as const;

  return {
    selectedModel,
    setSelectedModel: handleModelChange,
    availableModels: accessibleModels,
    allModels: availableModels,
    isLoading,
    modelsData: accountState ? { models: accountState.models, tier: accountState.subscription.tier_key } : undefined,
    subscriptionStatus,
    canAccessModel: (modelId: string) => {
      // Use the backend's `allowed` field directly - it's the source of truth
      const model = availableModels.find(m => m.id === modelId);
      if (!model) return false;
      return !model.requiresSubscription; // requiresSubscription = !allowed from backend
    },
    isSubscriptionRequired: (modelId: string) => {
      const model = availableModels.find(m => m.id === modelId);
      return model?.requiresSubscription || false;
    },
    
    handleModelChange,
    customModels: [] as any[],
    addCustomModel: (_model: any) => {},
    updateCustomModel: (_id: string, _model: any) => {},
    removeCustomModel: (_id: string) => {},
    
    getActualModelId: (modelId: string) => modelId,
    
    refreshCustomModels: () => {},
  };
};
