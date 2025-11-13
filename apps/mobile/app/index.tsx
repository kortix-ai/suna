import * as React from 'react';
import { View } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { KortixLoader } from '@/components/ui';
import { useAuthContext } from '@/contexts';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useAccountSetup } from '@/hooks/useAccountSetup';

export default function SplashScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { hasCompletedOnboarding, isLoading: onboardingLoading } = useOnboarding();
  const { isChecking: setupChecking, needsSetup } = useAccountSetup();

  React.useEffect(() => {
    if (!authLoading && !onboardingLoading && !setupChecking) {
      const timeoutId = setTimeout(() => {
        if (!isAuthenticated) {
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
  }, [authLoading, onboardingLoading, setupChecking, isAuthenticated, needsSetup, hasCompletedOnboarding, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background items-center justify-center">
        <KortixLoader size="xlarge" />
      </View>
    </>
  );
}

