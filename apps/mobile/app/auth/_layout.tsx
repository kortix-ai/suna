import { Redirect, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';
import { THEME } from '@/lib/utils/theme';

/**
 * Auth Layout
 *
 * Stack navigation for authentication screens.
 * CRITICAL: Authenticated users should NEVER see auth screens.
 * This layout immediately redirects authenticated users to the start screen.
 *
 * No loader of its own (KRTX-244): at launch the native splash covers the
 * auth check, and later `isLoading` only flips during a sign-in or sign-up,
 * where the screen's own disabled button shows progress. A full-screen loader
 * here unmounted the form mid-sign-in and stacked a second loader on the
 * start screen's.
 */
export default function AuthLayout() {
  const { colorScheme } = useColorScheme();
  const { isAuthenticated } = useAuthContext();

  // CRITICAL: Authenticated users should NEVER be on auth screens
  // Redirect them immediately to home
  if (isAuthenticated) {
    log.log('🚫 Auth layout: user is authenticated, redirecting to the last project');
    return <Redirect href="/" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: colorScheme === 'dark' ? THEME.dark.background : THEME.light.background,
        },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="email" />
    </Stack>
  );
}

