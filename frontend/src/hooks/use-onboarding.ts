'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  content: React.ReactNode;
  canSkip?: boolean;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

export interface UserTypeData {
  userType?: 'individual' | 'company';
  role?: string;
  selectedAt?: number;
}

interface OnboardingState {
  isOpen: boolean;
  currentStep: number;
  steps: OnboardingStep[];
  hasCompletedOnboarding: boolean;
  hasTriggeredPostSubscription: boolean;
  userTypeData: UserTypeData;
  
  // Actions
  setIsOpen: (open: boolean) => void;
  setCurrentStep: (step: number) => void;
  setSteps: (steps: OnboardingStep[]) => void;
  nextStep: () => void;
  previousStep: () => void;
  skipStep: () => void;
  completeOnboarding: () => void;
  startOnboarding: (steps?: OnboardingStep[]) => void;
  resetOnboarding: () => void;
  setTriggeredPostSubscription: (triggered: boolean) => void;
  setUserTypeData: (data: UserTypeData) => void;
}

const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      currentStep: 0,
      steps: [],
      hasCompletedOnboarding: false,
      hasTriggeredPostSubscription: false,
      userTypeData: {},
      
      setIsOpen: (open) => set({ isOpen: open }),
      
      setCurrentStep: (step) => set({ currentStep: step }),
      
      setSteps: (steps) => set({ steps }),
      
      nextStep: () => {
        const { currentStep, steps } = get();
        if (currentStep < steps.length - 1) {
          set({ currentStep: currentStep + 1 });
        } else {
          // Completed all steps
          get().completeOnboarding();
        }
      },
      
      previousStep: () => {
        const { currentStep } = get();
        if (currentStep > 0) {
          set({ currentStep: currentStep - 1 });
        }
      },
      
      skipStep: () => {
        get().nextStep();
      },
      
      completeOnboarding: () => {
        set({ 
          isOpen: false, 
          hasCompletedOnboarding: true,
          currentStep: 0 
        });
      },
      
      startOnboarding: (steps) => {
        if (steps) {
          set({ steps });
        }
        set({ 
          isOpen: true, 
          currentStep: 0,
          hasCompletedOnboarding: false 
        });
      },
      
      resetOnboarding: () => {
        set({ 
          isOpen: false,
          currentStep: 0,
          hasCompletedOnboarding: false,
          hasTriggeredPostSubscription: false,
          steps: [],
          userTypeData: {}
        });
      },
      
      setTriggeredPostSubscription: (triggered) => {
        set({ hasTriggeredPostSubscription: triggered });
      },
      
      setUserTypeData: (data) => {
        set({ userTypeData: { ...data, selectedAt: Date.now() } });
      },
    }),
    {
      name: 'onboarding-storage-v1',
      partialize: (state) => ({
        hasCompletedOnboarding: state.hasCompletedOnboarding,
        hasTriggeredPostSubscription: state.hasTriggeredPostSubscription,
        userTypeData: state.userTypeData,
      }),
    }
  )
);

export const useOnboarding = () => {
  const store = useOnboardingStore();
  
  // Computed values
  const isLastStep = store.currentStep === store.steps.length - 1;
  const isFirstStep = store.currentStep === 0;
  const currentStepData = store.steps[store.currentStep];
  const progress = store.steps.length > 0 ? ((store.currentStep + 1) / store.steps.length) * 100 : 0;
  
  return {
    ...store,
    isLastStep,
    isFirstStep,
    currentStepData,
    progress,
    isCompleted: store.hasCompletedOnboarding,
  };
};

// Hook for checking if onboarding should trigger after subscription
export const usePostSubscriptionOnboarding = () => {
  const onboarding = useOnboarding();
  
  const shouldTriggerOnboarding = (subscriptionData: any) => {
    // Don't trigger if already completed or already triggered
    if (onboarding.hasCompletedOnboarding || onboarding.hasTriggeredPostSubscription) {
      return false;
    }
    
    // Check if user has active subscription or trial
    const hasActiveSubscription = subscriptionData?.subscription && 
                                 subscriptionData.subscription.status === 'active' &&
                                 !subscriptionData.subscription.cancel_at_period_end;
    
    const hasActiveTrial = subscriptionData?.trial_status === 'active';
    const hasActiveTier = subscriptionData?.tier && 
                         subscriptionData.tier.name !== 'none' && 
                         subscriptionData.tier.name !== 'free';
    
    return (hasActiveSubscription && hasActiveTier) || (hasActiveTrial && hasActiveTier);
  };
  
  const triggerPostSubscriptionOnboarding = () => {
    if (!onboarding.hasTriggeredPostSubscription) {
      onboarding.setTriggeredPostSubscription(true);
      // The actual steps will be set by the component that uses this
      return true;
    }
    return false;
  };
  
  return {
    shouldTriggerOnboarding,
    triggerPostSubscriptionOnboarding,
  };
};
