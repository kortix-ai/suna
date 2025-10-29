import * as React from 'react';
import { View } from 'react-native';
import { useRouter, Stack, type Href } from 'expo-router';
import { KortixLoader } from '@/components/ui';
import { useAuthContext } from '@/contexts';
import { useOnboarding } from '@/hooks/useOnboarding';

/**
 * Splash Screen
 * 
 * Shown while checking authentication and onboarding status
 * Routes user to appropriate screen based on state:
 * - Not authenticated → Sign In
 * - Authenticated + No onboarding → Onboarding
 * - Authenticated + Has onboarding → App
 */
export default function SplashScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { hasCompletedOnboarding, isLoading: onboardingLoading } = useOnboarding();

  // Route user once we have all the info
  React.useEffect(() => {
    if (!authLoading && !onboardingLoading) {
      // Small delay for smooth transition
      setTimeout(() => {
        if (!isAuthenticated) {
          console.log('🔐 User not authenticated, routing to sign in');
          router.replace('/auth/sign-in' as Href);
        } else if (!hasCompletedOnboarding) {
          console.log('👋 User needs onboarding, routing to onboarding');
          router.replace('/onboarding' as Href);
        } else {
          console.log('✅ User authenticated and onboarded, routing to app');
          router.replace('/' as Href);
        }
      }, 800); // Minimum splash display time
    }
  }, [authLoading, onboardingLoading, isAuthenticated, hasCompletedOnboarding, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background items-center justify-center">
        <KortixLoader size="xlarge" />
      </View>
    </>
  );
}

