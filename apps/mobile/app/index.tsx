/**
 * Splash/Decision Screen
 *
 * For self-hosted Computer: simply checks auth and routes to /auth or /home.
 * No billing, no onboarding, no subscription checks.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';
import { ActivityIndicator } from 'react-native';
import { useColorScheme } from 'nativewind';

export default function SplashScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [hasNavigated, setHasNavigated] = React.useState(false);

  React.useEffect(() => {
    setHasNavigated(false);
  }, []);

  React.useEffect(() => {
    if (hasNavigated) return;
    if (authLoading) return;

    const timer = setTimeout(() => {
      if (hasNavigated) return;
      setHasNavigated(true);

      if (!isAuthenticated) {
        log.log('🚀 → /auth (not authenticated)');
        router.replace('/auth');
      } else {
        log.log('🚀 → /projects (authenticated)');
        router.replace('/projects');
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [authLoading, isAuthenticated, hasNavigated, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        className={`flex-1 items-center justify-center ${
          isDark ? 'bg-black' : 'bg-white'
        }`}
      >
        <ActivityIndicator
          size="large"
          color={isDark ? '#a1a1aa' : '#71717a'}
        />
        <Text
          className={`text-sm mt-4 ${
            isDark ? 'text-zinc-500' : 'text-zinc-400'
          }`}
        >
          {authLoading ? 'Checking session...' : 'Redirecting...'}
        </Text>
      </View>
    </>
  );
}
