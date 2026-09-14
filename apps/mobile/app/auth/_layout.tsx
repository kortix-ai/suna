import { useRouter, Redirect } from 'expo-router';
import { AppStack, usePushTransition } from '@/components/navigation/stack-transitions';
import { useColorScheme } from 'nativewind';
import { useAuthContext } from '@/contexts';
import { View } from 'react-native';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { log } from '@/lib/logger';
import { THEME } from '@/lib/utils/theme';

/**
 * Auth Layout
 *
 * Stack navigation for authentication screens.
 * CRITICAL: Authenticated users should NEVER see auth screens.
 * This layout immediately redirects authenticated users to /projects.
 */
export default function AuthLayout() {
  const { colorScheme } = useColorScheme();
  const { isAuthenticated, isLoading } = useAuthContext();
  const pushTransition = usePushTransition();

  // While auth is loading, show nothing to prevent flash
  if (isLoading) {
    return (
      <View 
        style={{ 
          flex: 1, 
          backgroundColor: colorScheme === 'dark' ? THEME.dark.background : THEME.light.background,
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
    log.log('🚫 Auth layout: user is authenticated, redirecting to /projects');
    return <Redirect href="/projects" />;
  }

  return (
    <AppStack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: colorScheme === 'dark' ? THEME.dark.background : THEME.light.background,
        },
        // Same push/pop as every stack (components/navigation/stack-transitions).
        ...pushTransition,
      }}
    >
      <AppStack.Screen name="index" />
      <AppStack.Screen name="email" />
    </AppStack>
  );
}

