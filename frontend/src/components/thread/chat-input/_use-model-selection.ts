'use client';

import { useSubscriptionData } from '@/contexts/SubscriptionContext';
import { useState, useEffect, useMemo } from 'react';
import { isLocalMode } from '@/lib/config';
import { useAvailableModels } from '@/hooks/react-query/subscriptions/use-model';

export const STORAGE_KEY_MODEL = 'suna-preferred-model-v3';
export const STORAGE_KEY_CUSTOM_MODELS = 'customModels';
export const DEFAULT_PREMIUM_MODEL_ID = 'claude-sonnet-4';
export const DEFAULT_FREE_MODEL_ID = 'moonshotai/kimi-k2';

export const testLocalStorage = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const testKey = 'test-storage';
    const testValue = 'test-value';
    localStorage.setItem(testKey, testValue);
    const retrieved = localStorage.getItem(testKey);
    localStorage.removeItem(testKey);
    return retrieved === testValue;
  } catch (error) {
    console.error('localStorage test failed:', error);
    return false;
  }
};

export type SubscriptionStatus = 'no_subscription' | 'active';

export interface ModelOption {
  id: string;
  label: string;
  requiresSubscription: boolean;
  description?: string;
  top?: boolean;
  isCustom?: boolean;
  priority?: number;
}

export interface CustomModel {
  id: string;
  label: string;
}

export const MODELS = {
  'claude-sonnet-4': { 
    tier: 'none',
    priority: 100, 
    recommended: true,
    lowQuality: false
  },
  'gpt-5': { 
    tier: 'premium', 
    priority: 99,
    recommended: false,
    lowQuality: false
  },
  'google/gemini-2.5-pro': { 
    tier: 'premium', 
    priority: 96,
    recommended: false,
    lowQuality: false
  },
  'grok-4': { 
    tier: 'premium', 
    priority: 94,
    recommended: false,
    lowQuality: false
  },
  'sonnet-3.7': { 
    tier: 'premium', 
    priority: 93, 
    recommended: false,
    lowQuality: false
  },
  'sonnet-3.5': { 
    tier: 'premium', 
    priority: 90,
    recommended: false,
    lowQuality: false
  },

  'moonshotai/kimi-k2': { 
    tier: 'none', 
    priority: 100,
    recommended: true,
    lowQuality: false
  },
  'deepseek': { 
    tier: 'none', 
    priority: 95,
    recommended: false,
    lowQuality: false
  },
  'qwen3': { 
    tier: 'none', 
    priority: 90,
    recommended: false,
    lowQuality: false
  },
  'gpt-5-mini': { 
    tier: 'none', 
    priority: 85,
    recommended: false,
    lowQuality: false
  },
};

export const canAccessModel = (
  subscriptionStatus: SubscriptionStatus,
  requiresSubscription: boolean,
): boolean => {
  if (isLocalMode()) {
    return true;
  }
  return subscriptionStatus === 'active' || !requiresSubscription;
};

export const formatModelName = (name: string): string => {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export const getPrefixedModelId = (modelId: string, isCustom: boolean): string => {
  if (isCustom && !modelId.startsWith('openrouter/')) {
    return `openrouter/${modelId}`;
  }
  return modelId;
};

// Helper to get custom models from localStorage
export const getCustomModels = (): CustomModel[] => {
  if (!isLocalMode() || typeof window === 'undefined') return [];
  
  try {
    const storedModels = localStorage.getItem(STORAGE_KEY_CUSTOM_MODELS);
    if (!storedModels) return [];
    
    const parsedModels = JSON.parse(storedModels);
    if (!Array.isArray(parsedModels)) return [];
    
    return parsedModels
      .filter((model: any) => 
        model && typeof model === 'object' && 
        typeof model.id === 'string' && 
        typeof model.label === 'string');
  } catch (e) {
    console.error('Error parsing custom models:', e);
    return [];
  }
};

// Helper to save model preference to localStorage safely
const saveModelPreference = (modelId: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY_MODEL, modelId);
    console.log('✅ useModelSelection: Saved model preference to localStorage:', modelId);
  } catch (error) {
    console.warn('❌ useModelSelection: Failed to save model preference to localStorage:', error);
  }
};

export const useModelSelectionOld = () => {
  const [selectedModel, setSelectedModel] = useState(DEFAULT_FREE_MODEL_ID);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [hasInitialized, setHasInitialized] = useState(false);
  
  const { data: subscriptionData } = useSubscriptionData();
  const { data: modelsData, isLoading: isLoadingModels } = useAvailableModels({
    refetchOnMount: false,
  });
  
  const subscriptionStatus: SubscriptionStatus = (subscriptionData?.status === 'active' || subscriptionData?.status === 'trialing')
    ? 'active' 
    : 'no_subscription';

  // Function to refresh custom models from localStorage
  const refreshCustomModels = () => {
    if (isLocalMode() && typeof window !== 'undefined') {
      const freshCustomModels = getCustomModels();
      setCustomModels(freshCustomModels);
    }
  };

  // Load custom models from localStorage
  useEffect(() => {
    refreshCustomModels();
  }, []);

  // Generate model options list with consistent structure
  const MODEL_OPTIONS = useMemo(() => {
    let models = [];
    
    // Default models if API data not available
    if (!modelsData?.models || isLoadingModels) {
      models = [
        { 
          id: DEFAULT_FREE_MODEL_ID, 
          label: 'KIMI K2', 
          requiresSubscription: false,
          priority: 100,
          recommended: true
        },
        { 
          id: DEFAULT_PREMIUM_MODEL_ID, 
          label: 'Claude Sonnet 4', 
          requiresSubscription: true, 
          priority: 100,
          recommended: true
        },
      ];
    } else {
      // Process API-provided models - use clean data from new backend system
      models = modelsData.models.map(model => {
        // Use the clean data directly from the API (no more duplicates!)
        const shortName = model.short_name || model.id;
        const displayName = model.display_name || shortName;
        
        return {
          id: shortName,
          label: displayName,
          requiresSubscription: model.requires_subscription || false,
          priority: model.priority || 0,
          recommended: model.recommended || false,
          top: (model.priority || 0) >= 90, // Mark high-priority models as "top"
          lowQuality: false, // All models in new system are quality controlled
          capabilities: model.capabilities || [],
          contextWindow: model.context_window || 128000
        };
      });
    }
    
    // Add custom models if in local mode
    if (isLocalMode() && customModels.length > 0) {
      const customModelOptions = customModels.map(model => ({
        id: model.id,
        label: model.label || formatModelName(model.id),
        requiresSubscription: false,
        top: false,
        isCustom: true,
        priority: 30, // Low priority by default
        lowQuality: false,
        recommended: false
      }));
      
      models = [...models, ...customModelOptions];
    }
    
    // Sort models consistently in one place:
    // 1. First by recommended (recommended first)
    // 2. Then by priority (higher first)
    // 3. Finally by name (alphabetical)
    const sortedModels = models.sort((a, b) => {
      // First by recommended status
      if (a.recommended !== b.recommended) {
        return a.recommended ? -1 : 1;
      }

      // Then by priority (higher first)
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      
      // Finally by name
      return a.label.localeCompare(b.label);
    });
    return sortedModels;
  }, [modelsData, isLoadingModels, customModels]);

  // Get filtered list of models the user can access (no additional sorting)
  const availableModels = useMemo(() => {
    return isLocalMode() 
      ? MODEL_OPTIONS 
      : MODEL_OPTIONS.filter(model => 
          canAccessModel(subscriptionStatus, model.requiresSubscription)
        );
  }, [MODEL_OPTIONS, subscriptionStatus]);

  // Initialize selected model from localStorage ONLY ONCE
  useEffect(() => {
    if (typeof window === 'undefined' || hasInitialized) return;
    
    console.log('🔧 useModelSelection: Initializing model selection...');
    console.log('🔧 useModelSelection: isLoadingModels:', isLoadingModels);
    console.log('🔧 useModelSelection: subscriptionStatus:', subscriptionStatus);
    console.log('🔧 useModelSelection: localStorage test passed:', testLocalStorage());
    
    try {
      const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
      console.log('🔧 useModelSelection: Saved model from localStorage:', savedModel);
      
      // If we have a saved model, validate it's still available and accessible
      if (savedModel) {
        // Wait for models to load before validating
        if (isLoadingModels) {
          console.log('🔧 useModelSelection: Models still loading, using saved model temporarily:', savedModel);
          // Use saved model immediately while waiting for validation
          setSelectedModel(savedModel);
          setHasInitialized(true);
          return;
        }
        
        console.log('🔧 useModelSelection: Available MODEL_OPTIONS:', MODEL_OPTIONS.map(m => ({ id: m.id, requiresSubscription: m.requiresSubscription })));
        
        const modelOption = MODEL_OPTIONS.find(option => option.id === savedModel);
        const isCustomModel = isLocalMode() && customModels.some(model => model.id === savedModel);
        
        console.log('🔧 useModelSelection: modelOption found:', modelOption);
        console.log('🔧 useModelSelection: isCustomModel:', isCustomModel);
        
        // Check if saved model is still valid and accessible
        if (modelOption || isCustomModel) {
          const isAccessible = isLocalMode() || 
            canAccessModel(subscriptionStatus, modelOption?.requiresSubscription ?? false);
          
          console.log('🔧 useModelSelection: isAccessible:', isAccessible);
          
          if (isAccessible) {
            console.log('✅ useModelSelection: Using saved model:', savedModel);
            setSelectedModel(savedModel);
            setHasInitialized(true);
            return;
          } else {
            console.warn('⚠️ useModelSelection: Saved model not accessible with current subscription');
          }
        } else {
          // Model not found in current options, but preserve it anyway in case it's valid
          // This can happen during loading or if the API returns different models
          console.warn('⚠️ useModelSelection: Saved model not found in available options, but preserving:', savedModel);
          setSelectedModel(savedModel);
          setHasInitialized(true);
          return;
        }
      }
      
      // Fallback to default model
      const defaultModel = subscriptionStatus === 'active' ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
      console.log('🔧 useModelSelection: Using default model:', defaultModel);
      console.log('🔧 useModelSelection: Subscription status:', subscriptionStatus, '-> Default:', subscriptionStatus === 'active' ? 'PREMIUM (Claude Sonnet 4)' : 'FREE (KIMi K2)');
      setSelectedModel(defaultModel);
      saveModelPreference(defaultModel);
      setHasInitialized(true);
      
    } catch (error) {
      console.warn('❌ useModelSelection: Failed to load preferences from localStorage:', error);
      const defaultModel = subscriptionStatus === 'active' ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
      console.log('🔧 useModelSelection: Using fallback default model:', defaultModel);
      console.log('🔧 useModelSelection: Subscription status:', subscriptionStatus, '-> Fallback:', subscriptionStatus === 'active' ? 'PREMIUM (Claude Sonnet 4)' : 'FREE (KIMi K2)');
      setSelectedModel(defaultModel);
      saveModelPreference(defaultModel);
      setHasInitialized(true);
    }
  }, [subscriptionStatus, isLoadingModels, hasInitialized]);

  // Re-validate saved model after loading completes
  useEffect(() => {
    if (!hasInitialized || typeof window === 'undefined' || isLoadingModels) return;
    
    const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
    if (!savedModel || savedModel === selectedModel) return;
    
    console.log('🔧 useModelSelection: Re-validating saved model after loading:', savedModel);
    
    const modelOption = MODEL_OPTIONS.find(option => option.id === savedModel);
    const isCustomModel = isLocalMode() && customModels.some(model => model.id === savedModel);
    
    // If the saved model is now invalid, switch to default
    if (!modelOption && !isCustomModel) {
      console.warn('⚠️ useModelSelection: Saved model is invalid after loading, switching to default');
      const defaultModel = subscriptionStatus === 'active' ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
      setSelectedModel(defaultModel);
      saveModelPreference(defaultModel);
    } else if (modelOption && !isLocalMode()) {
      // Check subscription access for non-custom models
      const isAccessible = canAccessModel(subscriptionStatus, modelOption.requiresSubscription);
      if (!isAccessible) {
        console.warn('⚠️ useModelSelection: Saved model not accessible after subscription check, switching to default');
        const defaultModel = subscriptionStatus === 'active' ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
        setSelectedModel(defaultModel);
        saveModelPreference(defaultModel);
      }
    }
  }, [isLoadingModels, hasInitialized, MODEL_OPTIONS, customModels, subscriptionStatus]);

  // Re-validate current model when subscription status changes
  useEffect(() => {
    if (!hasInitialized || typeof window === 'undefined') return;
    
    console.log('🔧 useModelSelection: Subscription status changed, re-validating current model...');
    console.log('🔧 useModelSelection: Current selected model:', selectedModel);
    console.log('🔧 useModelSelection: New subscription status:', subscriptionStatus);
    
    // Skip validation if models are still loading
    if (isLoadingModels) return;
    
    // Check if current model is still accessible
    const modelOption = MODEL_OPTIONS.find(option => option.id === selectedModel);
    const isCustomModel = isLocalMode() && customModels.some(model => model.id === selectedModel);
    
    if (modelOption && !isCustomModel && !isLocalMode()) {
      const isAccessible = canAccessModel(subscriptionStatus, modelOption.requiresSubscription);
      
      if (!isAccessible) {
        console.warn('⚠️ useModelSelection: Current model no longer accessible, switching to default');
        const defaultModel = subscriptionStatus === 'active' ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
        console.log('🔧 useModelSelection: Subscription-based default switch:', subscriptionStatus === 'active' ? 'PREMIUM (Claude Sonnet 4)' : 'FREE (KIMi K2)');
        setSelectedModel(defaultModel);
        saveModelPreference(defaultModel);
      } else {
        console.log('✅ useModelSelection: Current model still accessible');
      }
    }
  }, [subscriptionStatus, selectedModel, hasInitialized, isLoadingModels]);

  // Handle model selection change
  const handleModelChange = (modelId: string) => {
    console.log('🔧 useModelSelection: handleModelChange called with:', modelId);
    console.log('🔧 useModelSelection: Available MODEL_OPTIONS:', MODEL_OPTIONS.map(m => m.id));
    
    // Refresh custom models from localStorage to ensure we have the latest
    if (isLocalMode()) {
      refreshCustomModels();
    }
    
    // First check if it's a custom model in local mode
    const isCustomModel = isLocalMode() && customModels.some(model => model.id === modelId);
    
    // Then check if it's in standard MODEL_OPTIONS
    const modelOption = MODEL_OPTIONS.find(option => option.id === modelId);
    
    console.log('🔧 useModelSelection: modelOption found:', modelOption);
    console.log('🔧 useModelSelection: isCustomModel:', isCustomModel);
    
    // Check if model exists in either custom models or standard options
    if (!modelOption && !isCustomModel) {
      console.warn('🔧 useModelSelection: Model not found in options:', modelId, MODEL_OPTIONS, isCustomModel, customModels);
      
      // Reset to default model when the selected model is not found
      const defaultModel = isLocalMode() ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
      console.log('🔧 useModelSelection: Resetting to default model:', defaultModel);
      setSelectedModel(defaultModel);
      saveModelPreference(defaultModel);
      return;
    }

    // Check access permissions (except for custom models in local mode)
    if (!isCustomModel && !isLocalMode() && 
        !canAccessModel(subscriptionStatus, modelOption?.requiresSubscription ?? false)) {
      console.warn('🔧 useModelSelection: Model not accessible:', modelId);
      return;
    }
    
    console.log('✅ useModelSelection: Setting model to:', modelId);
    setSelectedModel(modelId);
    saveModelPreference(modelId);
    console.log('✅ useModelSelection: Model change completed successfully');
  };

  // Get the actual model ID to send to the backend
  const getActualModelId = (modelId: string): string => {
    // No need for automatic prefixing in most cases - just return as is
    return modelId;
  };

  return {
    selectedModel,
    setSelectedModel: (modelId: string) => {
      handleModelChange(modelId);
    },
    subscriptionStatus,
    availableModels,
    allModels: MODEL_OPTIONS,  // Already pre-sorted
    customModels,
    getActualModelId,
    refreshCustomModels,
    canAccessModel: (modelId: string) => {
      if (isLocalMode()) return true;
      const model = MODEL_OPTIONS.find(m => m.id === modelId);
      return model ? canAccessModel(subscriptionStatus, model.requiresSubscription) : false;
    },
    isSubscriptionRequired: (modelId: string) => {
      return MODEL_OPTIONS.find(m => m.id === modelId)?.requiresSubscription || false;
    },
    // Debug utility to check current state
    debugState: () => {
      console.log('🔧 useModelSelection Debug State:');
      console.log('  selectedModel:', selectedModel);
      console.log('  hasInitialized:', hasInitialized);
      console.log('  subscriptionStatus:', subscriptionStatus);
      console.log('  isLoadingModels:', isLoadingModels);
      console.log('  localStorage value:', localStorage.getItem(STORAGE_KEY_MODEL));
      console.log('  localStorage test passes:', testLocalStorage());
      console.log('  defaultModel would be:', subscriptionStatus === 'active' ? `${DEFAULT_PREMIUM_MODEL_ID} (Claude Sonnet 4)` : `${DEFAULT_FREE_MODEL_ID} (KIMi K2)`);
      console.log('  availableModels:', availableModels.map(m => ({ id: m.id, requiresSubscription: m.requiresSubscription })));
    }
  };
};

// Export the new model selection hook
export { useModelSelection } from './_use-model-selection-new';

// Export the hook but not any sorting logic - sorting is handled internally