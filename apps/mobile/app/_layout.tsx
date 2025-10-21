import '@/global.css';

import { ROOBERT_FONTS } from '@/lib/fonts';
import { NAV_THEME } from '@/lib/theme';
import { initializeI18n } from '@/lib/i18n';
import { AuthProvider, LanguageProvider, AgentProvider } from '@/contexts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { useFonts } from 'expo-font';
import { Stack, SplashScreen } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'nativewind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

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
 * 
 * Note: No auth routing - users can access app directly
 * Auth drawer shows when needed for specific features
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
            <AgentProvider>
              <BottomSheetModalProvider>
                <ThemeProvider value={NAV_THEME[activeColorScheme]}>
                  <StatusBar style={activeColorScheme === 'dark' ? 'light' : 'dark'} />
                  <Stack screenOptions={{ headerShown: false }} />
                  <PortalHost />
                </ThemeProvider>
              </BottomSheetModalProvider>
            </AgentProvider>
          </AuthProvider>
        </LanguageProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}
