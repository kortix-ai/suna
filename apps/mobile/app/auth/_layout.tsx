import { Stack, useRouter, Redirect } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useAuthContext } from '@/contexts';
import { View } from 'react-native';
import { KortixLoader } from '@/components/ui';
import { log } from '@/lib/logger';

/**
 * Auth Layout
 * 
 * Stack navigation for authentication screens.
 * CRITICAL: Authenticated users should NEVER see auth screens.
 * This layout immediately redirects authenticated users to /home.
 */
export default function AuthLayout() {
  const { colorScheme } = useColorScheme();
  const { isAuthenticated, isLoading } = useAuthContext();

  // While auth is loading, show nothing to prevent flash
  if (isLoading) {
    return (
      <View 
        style={{ 
          flex: 1, 
          backgroundColor: colorScheme === 'dark' ? '#09090B' : '#FFFFFF',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <KortixLoader size="xlarge" />
      </View>
    );
  }

  // CRITICAL: Authenticated users should NEVER be on auth screens
  // Redirect them immediately to home
  if (isAuthenticated) {
    log.log('🚫 Auth layout: user is authenticated, redirecting to /home');
    return <Redirect href="/home" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: colorScheme === 'dark' ? '#09090B' : '#FFFFFF',
        },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}

