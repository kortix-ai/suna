import * as React from 'react';
import { View, Text } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { KortixLoader } from '@/components/ui';
import { useAuthContext, useBillingContext } from '@/contexts';
import { useOnboarding } from '@/hooks/useOnboarding';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { log } from '@/lib/logger';

// Safely import and configure expo-notifications
let Notifications: typeof import('expo-notifications') | null = null;
try {
  Notifications = require('expo-notifications');
  if (Notifications && Notifications.setNotificationHandler) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: false, // Commented out: was true
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  }
} catch (error) {
  log.warn('expo-notifications module not available:', error);
}

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
  const { expoPushToken } = usePushNotifications();
  
  // Log token status when it changes
  React.useEffect(() => {
    if (expoPushToken) {
      log.log('[SPLASH] ✅ expoPushToken available:', expoPushToken);
    } else {
      log.log('[SPLASH] ⚠️ expoPushToken is undefined (check [PUSH] logs for details)');
    }
  }, [expoPushToken]);
  
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

  // Optimize UX: For returning users (authenticated + onboarded), navigate immediately without waiting for all data
  // This prevents showing the loader for users who just want to open the app
  const canNavigateEarly = authReady && isAuthenticated && !onboardingLoading && hasCompletedOnboarding;
  const shouldNavigate = canNavigateEarly || allDataReady;

  // Status text for debugging
  const getStatusText = () => {
    if (!authReady) return 'Checking session...';
    if (!isAuthenticated) return 'Redirecting...';
    if (billingLoading) return 'Loading account...';
    if (!subscriptionData) return 'Fetching subscription...';
    if (onboardingLoading) return 'Checking setup...';
    return 'Almost there...';
  };

  // Debug logging
  React.useEffect(() => {
    log.log('📊 Splash:', {
      authLoading,
      isAuthenticated,
      billingLoading,
      subscriptionData: subscriptionData ? '✓' : '✗',
      onboardingLoading,
      hasCompletedOnboarding,
      hasActiveSubscription,
      allDataReady,
      canNavigateEarly,
      shouldNavigate,
      hasNavigated
    });
  }, [authLoading, isAuthenticated, billingLoading, subscriptionData, onboardingLoading, hasCompletedOnboarding, hasActiveSubscription, allDataReady, canNavigateEarly, shouldNavigate, hasNavigated]);

  React.useEffect(() => {
    // Don't navigate twice
    if (hasNavigated) return;
    
    // Wait until we can navigate (either early for returning users, or when all data is ready for new users)
    if (!shouldNavigate) return;

    // Small delay to ensure React state is settled
    const timer = setTimeout(() => {
      if (hasNavigated) return;
      setHasNavigated(true);

      // ROUTING DECISION
      if (!isAuthenticated) {
        log.log('🚀 → /auth (not authenticated)');
        router.replace('/auth');
        return;
      }

      // User is authenticated
      // PRIORITY: If user has completed onboarding, they've already been through 
      // the full setup flow - go straight to home, regardless of subscription status.
      // This prevents showing "Initializing Account" to users who already completed setup.
      if (hasCompletedOnboarding) {
        log.log('🚀 → /home (onboarding completed, early navigation:', canNavigateEarly, ')');
        router.replace('/home');
      } else if (!hasActiveSubscription) {
        // New user: Account initialization happens automatically via webhook on signup.
        // Only show setting-up as a fallback if webhook failed or user signed up before this change.
        log.log('🚀 → /setting-up (fallback: no subscription detected)');
        router.replace('/setting-up');
      } else {
        // Has subscription but hasn't completed onboarding
        log.log('🚀 → /onboarding');
        router.replace('/onboarding');
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [shouldNavigate, hasNavigated, isAuthenticated, hasActiveSubscription, hasCompletedOnboarding, canNavigateEarly, router]);

  const showLoader = !canNavigateEarly;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background items-center justify-center">
        {showLoader && (
          <>
            <KortixLoader customSize={56} />
            <Text className="text-muted-foreground text-sm mt-4">
              {getStatusText()}
            </Text>
          </>
        )}
      </View>
    </>
  );
}

