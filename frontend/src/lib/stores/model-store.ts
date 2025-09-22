import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isLocalMode } from '@/lib/config';

export interface CustomModel {
  id: string;
  label: string;
}

export interface ModelOption {
  id: string;
  label: string;
  requiresSubscription: boolean;
  description?: string;
  top?: boolean;
  isCustom?: boolean;
  priority?: number;
  recommended?: boolean;
  capabilities?: string[];
  contextWindow?: number;
  backendId?: string; // For mapping display names to backend IDs
}

export type SubscriptionStatus = 'no_subscription' | 'active';

interface ModelStore {
  selectedModel: string;
  customModels: CustomModel[];
  hasHydrated: boolean;
  
  setSelectedModel: (model: string) => void;
  addCustomModel: (model: CustomModel) => void;
  updateCustomModel: (id: string, model: CustomModel) => void;
  removeCustomModel: (id: string) => void;
  setCustomModels: (models: CustomModel[]) => void;
  setHasHydrated: (hydrated: boolean) => void;
  
  getDefaultModel: (subscriptionStatus: SubscriptionStatus) => string;
  resetToDefault: (subscriptionStatus: SubscriptionStatus) => void;
}

const DEFAULT_FREE_MODEL_ID = 'claude-sonnet-4';
const DEFAULT_PREMIUM_MODEL_ID = 'claude-sonnet-4';

export const useModelStore = create<ModelStore>()(
  persist(
    (set, get) => ({
      selectedModel: DEFAULT_FREE_MODEL_ID,
      customModels: [],
      hasHydrated: false,
      
      setSelectedModel: (model: string) => {
        set({ selectedModel: model });
      },
      
      addCustomModel: (model: CustomModel) => {
        const { customModels } = get();
        if (customModels.some(existing => existing.id === model.id)) {
          return;
        }
        const newCustomModels = [...customModels, model];
        set({ customModels: newCustomModels });
      },
      
      updateCustomModel: (id: string, model: CustomModel) => {
        const { customModels } = get();
        const newCustomModels = customModels.map(existing => 
          existing.id === id ? model : existing
        );
        set({ customModels: newCustomModels });
      },
      
      removeCustomModel: (id: string) => {
        const { customModels, selectedModel } = get();
        const newCustomModels = customModels.filter(model => model.id !== id);
        
        const updates: Partial<ModelStore> = { customModels: newCustomModels };
        if (selectedModel === id) {
          updates.selectedModel = DEFAULT_FREE_MODEL_ID;
        }
        
        set(updates);
      },
      
      setCustomModels: (models: CustomModel[]) => {
        set({ customModels: models });
      },
      
      setHasHydrated: (hydrated: boolean) => {
        set({ hasHydrated: hydrated });
      },
      
      getDefaultModel: (subscriptionStatus: SubscriptionStatus) => {
        if (isLocalMode()) {
          return DEFAULT_PREMIUM_MODEL_ID;
        }
        return subscriptionStatus === 'active' ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
      },
      
      resetToDefault: (subscriptionStatus: SubscriptionStatus) => {
        const defaultModel = get().getDefaultModel(subscriptionStatus);
        set({ selectedModel: defaultModel });
      },
    }),
    {
      name: 'suna-model-selection-v2',
      partialize: (state) => ({
        selectedModel: state.selectedModel,
        customModels: state.customModels,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHasHydrated(true);
        }
      },
    }
  )
);

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