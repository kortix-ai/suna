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

const getDefaultModel = (models: ModelOption[], hasActiveSubscription: boolean): string => {
  // Paid users get kortix/power, free users get kortix/basic
  if (hasActiveSubscription) {
    const powerModel = models.find(m => m.id === 'kortix/power');
    if (powerModel) return powerModel.id;
    
    // Fallback to any recommended model
    const recommendedModel = models.find(m => m.recommended);
    if (recommendedModel) return recommendedModel.id;
  } else {
    const basicModel = models.find(m => m.id === 'kortix/basic');
    if (basicModel) return basicModel.id;
  }
  
  // Fallback: pick from free models sorted by priority
  const freeModels = models.filter(m => !m.requiresSubscription);
  if (freeModels.length > 0) {
    const sortedFreeModels = freeModels.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return sortedFreeModels[0].id;
  }

  return models.length > 0 ? models[0].id : '';
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

    const hasActiveSubscription = accountState?.subscription.status === 'active' || 
                                   accountState?.subscription.status === 'trialing';
    
    // For paid users: always ensure they're on kortix/power (unless they manually changed it)
    // For free users: ensure they're on kortix/basic
    const expectedModel = hasActiveSubscription ? 'kortix/power' : 'kortix/basic';
    const hasExpectedModel = availableModels.some(m => m.id === expectedModel);
    
    // If no model selected, selected model is not accessible, or user is on wrong tier default
    const needsUpdate = !selectedModel || 
                        !accessibleModels.some(m => m.id === selectedModel) ||
                        (hasExpectedModel && selectedModel !== expectedModel && 
                         (selectedModel === 'kortix/basic' || selectedModel === 'kortix/power'));
    
    if (needsUpdate) {
      const defaultModelId = getDefaultModel(availableModels, hasActiveSubscription);
      
      // Make sure the default model is accessible
      const finalModel = accessibleModels.some(m => m.id === defaultModelId) 
        ? defaultModelId 
        : accessibleModels[0]?.id;
        
      if (finalModel && finalModel !== selectedModel) {
        console.log('🔧 useModelSelection: Setting default model:', finalModel, '(subscription:', hasActiveSubscription ? 'active' : 'free', ')');
        setSelectedModel(finalModel);
      }
    }
  }, [selectedModel, accessibleModels, availableModels, isLoading, setSelectedModel, accountState?.subscription.status]);

  // Auto-switch to Power mode when subscription becomes active (upgrade detected)
  useEffect(() => {
    if (isLoading || !availableModels.length) return;
    
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
    if (wasInactive && isNowActive && prevSubscriptionStatus.current !== null) {
      const powerModel = availableModels.find(m => m.id === 'kortix/power');
      if (powerModel) {
        console.log('🚀 useModelSelection: Subscription upgraded! Switching to kortix/power');
        setSelectedModel('kortix/power');
      }
    }
    
    // Update ref for next comparison
    prevSubscriptionStatus.current = currentStatus || null;
  }, [accountState?.subscription.status, availableModels, isLoading, setSelectedModel]);

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
