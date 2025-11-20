import '@/global.css';

import { ROOBERT_FONTS } from '@/lib/utils/fonts';
import { NAV_THEME } from '@/lib/utils/theme';
import { initializeI18n } from '@/lib/utils/i18n';
import { AuthProvider, LanguageProvider, AgentProvider, BillingProvider, AdvancedFeaturesProvider, GuestModeProvider, TrackingProvider, useAuthContext, useGuestMode } from '@/contexts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { useFonts } from 'expo-font';
import { Stack, SplashScreen, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as Linking from 'expo-linking';
import React, { useEffect, useState } from 'react';
import { useColorScheme } from 'nativewind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform } from 'react-native';
import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated';
import { supabase } from '@/api/supabase';

configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

SplashScreen.preventAutoHideAsync();

export {
  ErrorBoundary,
} from 'expo-router';

export default function RootLayout() {
  const { colorScheme, setColorScheme } = useColorScheme();
  const [i18nInitialized, setI18nInitialized] = useState(false);
  
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 2,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  }));
  
  const [fontsLoaded, fontError] = useFonts(ROOBERT_FONTS);

  useEffect(() => {
    initializeI18n().then(() => {
      console.log('✅ i18n initialized in RootLayout');
      setI18nInitialized(true);
    });
  }, []);

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
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    let isHandlingDeepLink = false;

    const handleDeepLink = async (event: { url: string }) => {
      if (isHandlingDeepLink) return;
      isHandlingDeepLink = true;

      console.log('🔗 Deep link received:', event.url);
      
      const url = event.url;
      const parsedUrl = Linking.parse(url);
      
      console.log('🔍 Parsed URL:', { hostname: parsedUrl.hostname, path: parsedUrl.path });
      
      if (parsedUrl.hostname === 'auth' && parsedUrl.path === 'callback') {
        console.log('📧 Email confirmation received, processing...');
        
        try {
          const hashFragment = url.split('#')[1];
          console.log('🔍 Hash fragment:', hashFragment);
          
          if (hashFragment) {
            const hashParams = new URLSearchParams(hashFragment);
            const access_token = hashParams.get('access_token');
            const refresh_token = hashParams.get('refresh_token');
            
            console.log('🔑 Tokens found:', { 
              hasAccessToken: !!access_token, 
              hasRefreshToken: !!refresh_token 
            });
            
                  if (access_token && refresh_token) {
                    console.log('✅ Setting session with tokens...');

                    const { data, error } = await supabase.auth.setSession({
                      access_token,
                      refresh_token,
                    });

                    if (error) {
                      console.error('❌ Failed to set session:', error);
                      isHandlingDeepLink = false;
                    } else {
                      console.log('✅ Session set! User logged in:', data.user?.email);

                      const router = require('expo-router').router;
                      setTimeout(() => {
                        console.log('🚀 Navigating to /setting-up');
                        router.replace('/setting-up');
                        isHandlingDeepLink = false;
                      }, 800);
                    }
                  } else {
                    console.log('⚠️ No tokens found in hash params');
                    isHandlingDeepLink = false;
                  }
          } else {
            console.log('⚠️ No hash fragment in URL');
            isHandlingDeepLink = false;
          }
        } catch (err) {
          console.error('❌ Error handling email confirmation:', err);
          isHandlingDeepLink = false;
        }
      } else {
        console.log('ℹ️ Not an auth callback, path:', parsedUrl.path);
        isHandlingDeepLink = false;
      }
    };

    const subscription = Linking.addEventListener('url', handleDeepLink);

    Linking.getInitialURL().then((url) => {
      if (url) {
        console.log('🔗 Initial URL found:', url);
        handleDeepLink({ url });
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  if (!i18nInitialized) {
    return null;
  }

  const activeColorScheme = colorScheme ?? 'light';

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <TrackingProvider>
          <LanguageProvider>
            <GuestModeProvider>
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
                              <Stack.Screen name="setting-up" />
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
            </GuestModeProvider>
          </LanguageProvider>
        </TrackingProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}


function AuthProtection({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { isGuestMode, isLoading: guestLoading } = useGuestMode();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (authLoading || guestLoading) return;

    const inAuthGroup = segments[0] === 'auth';
    const canAccessWithoutAuth = isAuthenticated || isGuestMode;

    if (!canAccessWithoutAuth && !inAuthGroup) {
      console.log('🚫 User not authenticated or in guest mode, redirecting to /auth');
      router.replace('/auth');
    }
  }, [isAuthenticated, isGuestMode, authLoading, guestLoading, segments, router]);

  return <>{children}</>;
}
