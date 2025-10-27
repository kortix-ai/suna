import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { useAuthContext } from '@/contexts';

/**
 * ProtectedRoute Component
 * 
 * Wrapper component that handles authentication-based routing
 * - Redirects to login if not authenticated
 * - Shows loading state while checking auth
 * 
 * @example
 * <ProtectedRoute>
 *   <HomeScreen />
 * </ProtectedRoute>
 */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthContext();
  const router = useRouter();
  const segments = useSegments();

  React.useEffect(() => {
    console.log('🔐 Protected route check:', { isAuthenticated, isLoading, segments });

    if (isLoading) {
      return;
    }

    const inAuthGroup = segments[0] === 'auth';

    if (!isAuthenticated && !inAuthGroup) {
      // Redirect to login if not authenticated and not in auth screens
      console.log('🎯 Redirecting to login');
      router.replace('/auth/login');
    } else if (isAuthenticated && inAuthGroup) {
      // Redirect to home if authenticated and in auth screens
      console.log('🎯 Redirecting to home');
      router.replace('/');
    }
  }, [isAuthenticated, isLoading, segments]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" color="hsl(var(--primary))" />
      </View>
    );
  }

  return <>{children}</>;
}

