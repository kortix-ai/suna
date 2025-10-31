import '@/global.css';

import { ROOBERT_FONTS } from '@/lib/utils/fonts';
import { NAV_THEME } from '@/lib/utils/theme';
import { initializeI18n } from '@/lib/utils/i18n';
import { AuthProvider, LanguageProvider, AgentProvider, BillingProvider, AdvancedFeaturesProvider, useAuthContext } from '@/contexts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { useFonts } from 'expo-font';
import { Stack, SplashScreen, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'nativewind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform } from 'react-native';
import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated';

// Configure Reanimated logger to disable strict mode warnings
// These warnings appear during theme changes and are overly sensitive
configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false, // Disable strict mode warnings
});

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

/**
 * Root Layout
 * 
 * This is the main entry point that:
 * 1. Loads fonts
 * 2. Provides auth context
 * 3. Sets up providers
 * 4. Handles navigation stacks
 * 5. Protects all routes except /auth - unauthenticated users are redirected to /auth
 */
export default function RootLayout() {
  const { colorScheme, setColorScheme } = useColorScheme();
  const [i18nInitialized, setI18nInitialized] = useState(false);
  
  // Initialize QueryClient inline
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 2,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  }));
  
  // Load Roobert fonts
  const [fontsLoaded, fontError] = useFonts(ROOBERT_FONTS);

  // Initialize i18n
  useEffect(() => {
    initializeI18n().then(() => {
      console.log('✅ i18n initialized in RootLayout');
      setI18nInitialized(true);
    });
  }, []);

  // Set light mode as default on first load
  useEffect(() => {
    if (!colorScheme) {
      setColorScheme('light');
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      const activeScheme = colorScheme ?? 'light';
      const backgroundColor = activeScheme === 'dark' ? '#000000' : '#FFFFFF';
      SystemUI.setBackgroundColorAsync(backgroundColor);
    }
  }, [colorScheme]);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      // Hide the splash screen after the fonts have loaded (or an error was returned)
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Prevent rendering until the fonts have loaded or error, and i18n is initialized
  if (!fontsLoaded && !fontError) {
    return null;
  }

  if (!i18nInitialized) {
    return null;
  }

  // Default to light if colorScheme is not set
  const activeColorScheme = colorScheme ?? 'light';

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <LanguageProvider>
          <AuthProvider>
            <BillingProvider>
              <AgentProvider>
                <AdvancedFeaturesProvider>
                  <BottomSheetModalProvider>
                    <ThemeProvider value={NAV_THEME[activeColorScheme]}>
                      <StatusBar style={activeColorScheme === 'dark' ? 'light' : 'dark'} />
                      <AuthProtection>
                        <Stack 
                          screenOptions={{ 
                            headerShown: false,
                            animation: 'fade',
                          }}
                        >
                          <Stack.Screen name="index" options={{ animation: 'none' }} />
                          <Stack.Screen name="onboarding" />
                          <Stack.Screen name="home" />
                          <Stack.Screen name="auth" />
                          <Stack.Screen name="trigger-detail" />
                          <Stack.Screen 
                            name="tool-modal" 
                            options={{ 
                              presentation: 'modal',
                              animation: 'slide_from_bottom',
                            }} 
                          />
                        </Stack>
                      </AuthProtection>
                      <PortalHost />
                    </ThemeProvider>
                  </BottomSheetModalProvider>
                </AdvancedFeaturesProvider>
              </AgentProvider>
            </BillingProvider>
          </AuthProvider>
        </LanguageProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}

/**
 * Auth Protection Component
 * 
 * Protects all routes except /auth
 * Redirects unauthenticated users to /auth automatically
 */
function AuthProtection({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthContext();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'auth';

    if (!isAuthenticated && !inAuthGroup) {
      // User is not authenticated and not in auth screens, redirect to auth
      console.log('🚫 User not authenticated, redirecting to /auth');
      router.replace('/auth');
    }
  }, [isAuthenticated, isLoading, segments, router]);

  return <>{children}</>;
}
