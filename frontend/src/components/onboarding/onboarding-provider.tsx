'use client';

import React, { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useOnboarding, usePostSubscriptionOnboarding } from '@/hooks/use-onboarding';
import { NewOnboardingPage } from './new-onboarding-page';
import { onboardingSteps } from './onboarding-config';
import { useSubscription } from '@/hooks/react-query/subscriptions/use-subscriptions';
import { useAuth } from '@/components/AuthProvider';

interface OnboardingProviderProps {
  children: React.ReactNode;
}

export function OnboardingProvider({ children }: OnboardingProviderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { data: subscription } = useSubscription({ enabled: !!user });
  const { shouldTriggerOnboarding, triggerPostSubscriptionOnboarding } = usePostSubscriptionOnboarding();
  const { isOpen, startOnboarding, completeOnboarding } = useOnboarding();

  // Check if we should trigger onboarding after subscription
  useEffect(() => {
    if (!subscription || !user) return;

    const trialStarted = searchParams?.get('trial') === 'started';
    const subscriptionSuccess = searchParams?.get('subscription') === 'success';
    
    console.log('🚀 Onboarding Provider - Checking trigger conditions:', {
      trialStarted,
      subscriptionSuccess,
      subscription: subscription,
      shouldTrigger: shouldTriggerOnboarding(subscription)
    });
    
    if ((trialStarted || subscriptionSuccess) && shouldTriggerOnboarding(subscription)) {
      console.log('✅ Triggering post-subscription onboarding');
      if (triggerPostSubscriptionOnboarding()) {
        console.log('🎯 Starting onboarding with default steps');
        startOnboarding(onboardingSteps);
      }
    }
  }, [subscription, user, searchParams, shouldTriggerOnboarding, triggerPostSubscriptionOnboarding, startOnboarding]);

  // Handle onboarding completion
  const handleOnboardingComplete = () => {
    completeOnboarding();
    // Clean up URL parameters
    const url = new URL(window.location.href);
    url.searchParams.delete('trial');
    url.searchParams.delete('subscription');
    router.replace(url.pathname + url.search);
  };

  return (
    <>
      {children}
      {isOpen && (
        <NewOnboardingPage 
          onComplete={handleOnboardingComplete}
        />
      )}
    </>
  );
}
