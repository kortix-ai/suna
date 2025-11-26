import * as React from 'react';
import { View } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { KortixLoader } from '@/components/ui';
import { useAuthContext, useBillingContext } from '@/contexts';
import { useOnboarding } from '@/hooks/useOnboarding';

/**
 * Splash/Decision Screen
 * 
 * This is the ONLY place that decides where to route users.
 * Account initialization now happens automatically via backend webhook on signup,
 * so most users will go directly to onboarding or home.
 */
export default function SplashScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { hasCompletedOnboarding, isLoading: onboardingLoading } = useOnboarding();
  const { hasActiveSubscription, isLoading: billingLoading, subscriptionData } = useBillingContext();
  
  // Track navigation to prevent double navigation
  const [hasNavigated, setHasNavigated] = React.useState(false);
  
  // Reset navigation flag when component mounts (fresh visit to splash)
  React.useEffect(() => {
    setHasNavigated(false);
  }, []);

  // Compute ready state
  // - Auth must be done loading
  // - If authenticated: billing must be done loading AND have data
  // - Onboarding check must be done
  const authReady = !authLoading;
  const billingReady = !isAuthenticated || (!billingLoading && subscriptionData !== null);
  const onboardingReady = !isAuthenticated || !onboardingLoading;
  const allDataReady = authReady && billingReady && onboardingReady;

  // Debug logging
  React.useEffect(() => {
    console.log('📊 Splash:', {
      authLoading,
      isAuthenticated,
      billingLoading,
      subscriptionData: subscriptionData ? '✓' : '✗',
      onboardingLoading,
      hasCompletedOnboarding,
      hasActiveSubscription,
      allDataReady,
      hasNavigated
    });
  }, [authLoading, isAuthenticated, billingLoading, subscriptionData, onboardingLoading, hasCompletedOnboarding, hasActiveSubscription, allDataReady, hasNavigated]);

  React.useEffect(() => {
    // Don't navigate twice
    if (hasNavigated) return;
    
    // Wait until all data is ready
    if (!allDataReady) return;

    // Small delay to ensure React state is settled
    const timer = setTimeout(() => {
      if (hasNavigated) return;
      setHasNavigated(true);

      // ROUTING DECISION
      if (!isAuthenticated) {
        console.log('🚀 → /auth (not authenticated)');
        router.replace('/auth');
        return;
      }

      // User is authenticated
      // Account initialization happens automatically via webhook on signup.
      // Most users will have a subscription by now. Only show setting-up
      // as a fallback if webhook failed or user signed up before this change.
      if (!hasActiveSubscription) {
        console.log('🚀 → /setting-up (fallback: no subscription detected)');
        router.replace('/setting-up');
      } else if (!hasCompletedOnboarding) {
        console.log('🚀 → /onboarding');
        router.replace('/onboarding');
      } else {
        console.log('🚀 → /home');
        router.replace('/home');
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [allDataReady, hasNavigated, isAuthenticated, hasActiveSubscription, hasCompletedOnboarding, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background items-center justify-center">
        <KortixLoader size="xlarge" />
      </View>
    </>
  );
}

