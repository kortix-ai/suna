'use client';

import { useModelStore } from '@/stores/model-store';
import { useEffect, useMemo, useRef } from 'react';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
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

const getDefaultModel = (accessibleModels: ModelOption[], hasActiveSubscription: boolean): string => {
  // Only suggest models that are actually accessible
  // Paid users get kortix/power if accessible, free users get kortix/basic
  if (hasActiveSubscription) {
    const powerModel = accessibleModels.find(m => m.id === 'kortix/power');
    if (powerModel) return powerModel.id;
    
    // Fallback to any recommended model that's accessible
    const recommendedModel = accessibleModels.find(m => m.recommended);
    if (recommendedModel) return recommendedModel.id;
  } else {
    const basicModel = accessibleModels.find(m => m.id === 'kortix/basic');
    if (basicModel) return basicModel.id;
  }
  
  // Fallback: pick from accessible models sorted by priority
  if (accessibleModels.length > 0) {
    const sortedModels = accessibleModels.sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return (b.priority || 0) - (a.priority || 0);
    });
    return sortedModels[0].id;
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
  
  // Track previous subscription status to detect upgrades
  const prevSubscriptionStatus = useRef<string | null>(null);

  // Transform API data to ModelOption format
  const availableModels = useMemo<ModelOption[]>(() => {
    if (!accountState?.models) return [];
    
    return accountState.models.map(model => ({
      id: model.id,
      label: model.name,
      requiresSubscription: !model.allowed, // If not allowed, requires subscription
      priority: model.priority || 0,
      recommended: model.recommended || false,
      capabilities: model.capabilities || [],
      contextWindow: model.context_window || 128000,
    })).sort((a, b) => {
      // Sort by recommended first, then priority, then name
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.label.localeCompare(b.label);
    });
  }, [accountState?.models]);

  // Get accessible models based on subscription
  const accessibleModels = useMemo(() => {
    const hasActiveSubscription = accountState?.subscription.status === 'active' || 
                                   accountState?.subscription.status === 'trialing';
    return availableModels.filter(model => hasActiveSubscription || !model.requiresSubscription);
  }, [availableModels, accountState?.subscription.status]);

  // Initialize selected model when data loads
  useEffect(() => {
    if (isLoading || !accessibleModels.length) return;

    // If no model selected or selected model is not accessible, set a default
    const needsUpdate = !selectedModel || 
                        !accessibleModels.some(m => m.id === selectedModel);
    
    if (needsUpdate) {
      const hasActiveSubscription = accountState?.subscription.status === 'active' || 
                                     accountState?.subscription.status === 'trialing';
      const defaultModelId = getDefaultModel(accessibleModels, hasActiveSubscription);
      
      if (defaultModelId && defaultModelId !== selectedModel) {
        console.log('🔧 useModelSelection: Setting default model:', defaultModelId, '(subscription:', hasActiveSubscription ? 'active' : 'free', ')');
        setSelectedModel(defaultModelId);
      }
    }
  }, [selectedModel, accessibleModels, isLoading, setSelectedModel, accountState?.subscription.status]);

  // Auto-switch to Power mode when subscription becomes active (upgrade detected)
  useEffect(() => {
    if (isLoading || !accessibleModels.length) return;
    
    const currentStatus = accountState?.subscription.status;
    const wasInactive = prevSubscriptionStatus.current === null || 
                        prevSubscriptionStatus.current === 'canceled' || 
                        prevSubscriptionStatus.current === 'incomplete' ||
                        prevSubscriptionStatus.current === 'incomplete_expired' ||
                        prevSubscriptionStatus.current === 'past_due' ||
                        prevSubscriptionStatus.current === 'unpaid' ||
                        prevSubscriptionStatus.current === 'no_subscription' ||
                        !prevSubscriptionStatus.current;
    const isNowActive = currentStatus === 'active' || currentStatus === 'trialing';
    
    // Detect upgrade: was inactive, now active
    // Only switch if kortix/power is actually accessible
    if (wasInactive && isNowActive && prevSubscriptionStatus.current !== null) {
      const powerModel = accessibleModels.find(m => m.id === 'kortix/power');
      if (powerModel) {
        console.log('🚀 useModelSelection: Subscription upgraded! Switching to kortix/power');
        setSelectedModel('kortix/power');
      }
    }
    
    // Update ref for next comparison
    prevSubscriptionStatus.current = currentStatus || null;
  }, [accountState?.subscription.status, accessibleModels, isLoading, setSelectedModel]);

  const handleModelChange = (modelId: string) => {
    const model = accessibleModels.find(m => m.id === modelId);
    if (model) {
      console.log('🔧 useModelSelection: Changing model to:', modelId);
      setSelectedModel(modelId);
    }
  };

  const subscriptionStatus = (accountState?.subscription.status === 'active' || 
                              accountState?.subscription.status === 'trialing') 
    ? 'active' as const 
    : 'no_subscription' as const;

  return {
    selectedModel,
    setSelectedModel: handleModelChange,
    availableModels: accessibleModels,
    allModels: availableModels,
    isLoading,
    modelsData: accountState ? { models: accountState.models, tier: accountState.subscription.tier_key } : undefined,
    subscriptionStatus,
    canAccessModel: (modelId: string) => {
      const model = availableModels.find(m => m.id === modelId);
      if (!model) return false;
      const hasActiveSubscription = subscriptionStatus === 'active';
      return hasActiveSubscription || !model.requiresSubscription;
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
