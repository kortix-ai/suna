import * as React from 'react';
import { View } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { KortixLoader } from '@/components/ui';
import { useAuthContext, useGuestMode } from '@/contexts';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useAccountSetup } from '@/hooks/useAccountSetup';

export default function SplashScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { isGuestMode, isLoading: guestLoading, exitGuestMode } = useGuestMode();
  const { hasCompletedOnboarding, isLoading: onboardingLoading } = useOnboarding();
  const { isChecking: setupChecking, needsSetup } = useAccountSetup();
  const [hasClearedGuestMode, setHasClearedGuestMode] = React.useState(false);

  // Clear guest mode if user is authenticated (only once)
  React.useEffect(() => {
    const clearGuestModeIfAuthenticated = async () => {
      if (!authLoading && !guestLoading && isAuthenticated && isGuestMode && !hasClearedGuestMode) {
        console.log('🔐 User is authenticated but guest mode is active. Clearing guest mode...');
        await exitGuestMode();
        setHasClearedGuestMode(true);
        console.log('✅ Guest mode cleared');
      }
    };
    
    clearGuestModeIfAuthenticated();
  }, [authLoading, guestLoading, isAuthenticated, isGuestMode, exitGuestMode, hasClearedGuestMode]);

  React.useEffect(() => {
    // Wait for all loading states and guest mode clearing to complete
    if (!authLoading && !onboardingLoading && !setupChecking && !guestLoading) {
      const timeoutId = setTimeout(() => {
        console.log('🚀 App startup routing decision:', {
          isGuestMode,
          isAuthenticated,
          needsSetup,
          hasCompletedOnboarding,
          hasClearedGuestMode
        });
        
        // If user is authenticated, don't route to guest mode even if flag is still set
        // (it will be cleared by the effect above)
        if (isGuestMode && !isAuthenticated) {
          console.log('👀 Guest mode active, routing to home');
          router.replace('/home');
        } else if (!isAuthenticated) {
          console.log('🔐 User not authenticated, routing to sign in');
          router.replace('/auth');
        } else if (needsSetup) {
          console.log('🔧 Account needs setup, routing to setup screen');
          router.replace('/setting-up');
        } else if (!hasCompletedOnboarding) {
          console.log('👋 User needs onboarding, routing to onboarding');
          router.replace('/onboarding');
        } else {
          console.log('✅ User authenticated and onboarded, routing to app');
          router.replace('/home');
        }
      }, 300);

      return () => clearTimeout(timeoutId);
    }
  }, [authLoading, onboardingLoading, setupChecking, guestLoading, isAuthenticated, isGuestMode, needsSetup, hasCompletedOnboarding, router, hasClearedGuestMode]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background items-center justify-center">
        <KortixLoader size="xlarge" />
      </View>
    </>
  );
}

