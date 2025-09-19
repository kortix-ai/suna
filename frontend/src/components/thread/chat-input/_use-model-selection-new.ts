'use client';

import { useSubscriptionData } from '@/contexts/SubscriptionContext';
import { useEffect, useMemo } from 'react';
import { isLocalMode } from '@/lib/config';
import { useAvailableModels } from '@/hooks/react-query/subscriptions/use-model';
import {
  useModelStore,
  canAccessModel,
  formatModelName,
  getPrefixedModelId,
  type SubscriptionStatus,
  type ModelOption,
  type CustomModel
} from '@/lib/stores/model-store';

export const useModelSelection = () => {
  const { data: subscriptionData } = useSubscriptionData();
  const { data: modelsData, isLoading: isLoadingModels } = useAvailableModels({
    refetchOnMount: false,
  });
  
  const {
    selectedModel,
    customModels,
    hasHydrated,
    setSelectedModel,
    addCustomModel,
    updateCustomModel,
    removeCustomModel,
    setCustomModels,
    setHasHydrated,
    getDefaultModel,
    resetToDefault,
  } = useModelStore();
  
  const subscriptionStatus: SubscriptionStatus = (subscriptionData?.subscription?.status === 'active' || subscriptionData?.subscription?.status === 'trialing')
    ? 'active' 
    : 'no_subscription';

  useEffect(() => {
    if (isLocalMode() && hasHydrated && typeof window !== 'undefined') {
      try {
        const storedModels = localStorage.getItem('customModels');
        if (storedModels) {
          const parsedModels = JSON.parse(storedModels);
          if (Array.isArray(parsedModels)) {
            const validModels = parsedModels.filter((model: any) => 
              model && typeof model === 'object' && 
              typeof model.id === 'string' && 
              typeof model.label === 'string'
            );
            setCustomModels(validModels);
          }
        }
      } catch (e) {
        console.error('Error loading custom models:', e);
      }
    }
  }, [isLocalMode, hasHydrated, setCustomModels]);

  const MODEL_OPTIONS = useMemo(() => {
    let models: ModelOption[] = [];
    if (!modelsData?.models || isLoadingModels) {
      models = [
        { 
          id: 'moonshotai/kimi-k2', 
          label: 'Kimi K2', 
          requiresSubscription: false,
          priority: 100,
          recommended: true
        },
        { 
          id: 'claude-sonnet-4', 
          label: 'Claude Sonnet 4', 
          requiresSubscription: true, 
          priority: 100,
          recommended: true
        },
      ];
    } else {
      models = modelsData.models.map(model => {
        const shortName = model.short_name || model.id;
        const displayName = model.display_name || shortName;
        
        return {
          id: shortName,
          label: displayName,
          requiresSubscription: model.requires_subscription || false,
          priority: model.priority || 0,
          recommended: model.recommended || false,
          top: (model.priority || 0) >= 90,
          capabilities: model.capabilities || [],
          contextWindow: model.context_window || 128000
        };
      });
    }
    
    if (isLocalMode() && customModels.length > 0) {
      const customModelOptions = customModels.map(model => ({
        id: model.id,
        label: model.label || formatModelName(model.id),
        requiresSubscription: false,
        top: false,
        isCustom: true,
        priority: 30,
      }));
      
      models = [...models, ...customModelOptions];
    }
    
    const sortedModels = models.sort((a, b) => {
      if (a.recommended !== b.recommended) {
        return a.recommended ? -1 : 1;
      }

      if (a.priority !== b.priority) {
        return (b.priority || 0) - (a.priority || 0);
      }
      
      return a.label.localeCompare(b.label);
    });
    
    return sortedModels;
  }, [modelsData, isLoadingModels, customModels]);

  const availableModels = useMemo(() => {
    return isLocalMode() 
      ? MODEL_OPTIONS 
      : MODEL_OPTIONS.filter(model => 
          canAccessModel(subscriptionStatus, model.requiresSubscription)
        );
  }, [MODEL_OPTIONS, subscriptionStatus]);

  useEffect(() => {
    if (!hasHydrated || isLoadingModels || typeof window === 'undefined') {
      return;
    }
    
    const isValidModel = MODEL_OPTIONS.some(model => model.id === selectedModel) ||
                        (isLocalMode() && customModels.some(model => model.id === selectedModel));
    
    if (!isValidModel) {
      console.log('🔧 ModelSelection: Invalid model detected, resetting to default');
      resetToDefault(subscriptionStatus);
      return;
    }
    
    if (!isLocalMode()) {
      const modelOption = MODEL_OPTIONS.find(m => m.id === selectedModel);
      if (modelOption && !canAccessModel(subscriptionStatus, modelOption.requiresSubscription)) {
        console.log('🔧 ModelSelection: User lost access to model, resetting to default');
        resetToDefault(subscriptionStatus);
      }
    }
  }, [hasHydrated, selectedModel, subscriptionStatus, MODEL_OPTIONS, customModels, isLoadingModels, resetToDefault]);

  const handleModelChange = (modelId: string) => {
    const isCustomModel = isLocalMode() && customModels.some(model => model.id === modelId);
    
    const modelOption = MODEL_OPTIONS.find(option => option.id === modelId);
    
    if (!modelOption && !isCustomModel) {
      resetToDefault(subscriptionStatus);
      return;
    }

    if (!isCustomModel && !isLocalMode() && 
        !canAccessModel(subscriptionStatus, modelOption?.requiresSubscription ?? false)) {
      return;
    }
    
    setSelectedModel(modelId);
  };

  const getActualModelId = (modelId: string): string => {
    const isCustomModel = isLocalMode() && customModels.some(model => model.id === modelId);
    return isCustomModel ? getPrefixedModelId(modelId, true) : modelId;
  };

  const refreshCustomModels = () => {
    if (isLocalMode() && typeof window !== 'undefined') {
      try {
        const storedModels = localStorage.getItem('customModels');
        if (storedModels) {
          const parsedModels = JSON.parse(storedModels);
          if (Array.isArray(parsedModels)) {
            const validModels = parsedModels.filter((model: any) => 
              model && typeof model === 'object' && 
              typeof model.id === 'string' && 
              typeof model.label === 'string'
            );
            setCustomModels(validModels);
          }
        }
      } catch (e) {
        console.error('Error loading custom models:', e);
      }
    }
  };

  return {
    selectedModel,
    handleModelChange,
    setSelectedModel: handleModelChange,
    availableModels,
    allModels: MODEL_OPTIONS,
    customModels,
    addCustomModel,
    updateCustomModel,
    removeCustomModel,
    refreshCustomModels,
    getActualModelId,
    canAccessModel: (modelId: string) => {
      if (isLocalMode()) return true;
      const model = MODEL_OPTIONS.find(m => m.id === modelId);
      return model ? canAccessModel(subscriptionStatus, model.requiresSubscription) : false;
    },
    isSubscriptionRequired: (modelId: string) => {
      return MODEL_OPTIONS.find(m => m.id === modelId)?.requiresSubscription || false;
    },
    subscriptionStatus,
  };
}; 