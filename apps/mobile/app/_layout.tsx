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
  const router = useRouter();
  
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
      if (isHandlingDeepLink) {
        console.log('⏸️ Already handling deep link, skipping...');
        return;
      }
      isHandlingDeepLink = true;

      console.log('🔗 Deep link received:', event.url);
      
      const url = event.url;
      const parsedUrl = Linking.parse(url);
      
      console.log('🔍 Parsed URL:', { 
        hostname: parsedUrl.hostname, 
        path: parsedUrl.path,
        queryParams: parsedUrl.queryParams,
      });
      
      if (parsedUrl.hostname === 'auth' && parsedUrl.path === 'callback') {
        console.log('📧 Auth callback received, processing...');
        
        try {
          // Check for terms_accepted in query params (from redirect URL)
          const termsAccepted = parsedUrl.queryParams?.terms_accepted === 'true';
          
          // Extract tokens from hash fragment (Supabase sends tokens in hash)
          const hashIndex = url.indexOf('#');
          let access_token: string | null = null;
          let refresh_token: string | null = null;
          
          if (hashIndex !== -1) {
            const hashFragment = url.substring(hashIndex + 1);
            console.log('🔍 Hash fragment:', hashFragment.substring(0, 100) + '...');
            
            // Parse hash fragment - can be URLSearchParams format or JSON
            try {
              const hashParams = new URLSearchParams(hashFragment);
              access_token = hashParams.get('access_token');
              refresh_token = hashParams.get('refresh_token');
              
              // Also try parsing as JSON (some formats)
              if (!access_token && hashFragment.startsWith('{')) {
                const hashData = JSON.parse(decodeURIComponent(hashFragment));
                access_token = hashData.access_token || hashData.accessToken;
                refresh_token = hashData.refresh_token || hashData.refreshToken;
              }
            } catch (parseError) {
              console.warn('⚠️ Error parsing hash fragment:', parseError);
              // Try direct extraction
              const accessTokenMatch = hashFragment.match(/access_token=([^&]+)/);
              const refreshTokenMatch = hashFragment.match(/refresh_token=([^&]+)/);
              access_token = accessTokenMatch ? decodeURIComponent(accessTokenMatch[1]) : null;
              refresh_token = refreshTokenMatch ? decodeURIComponent(refreshTokenMatch[1]) : null;
            }
          }
          
          console.log('🔑 Token extraction result:', { 
            hasAccessToken: !!access_token, 
            hasRefreshToken: !!refresh_token,
            termsAccepted,
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
              // Navigate to auth screen on error
              router.replace('/auth');
              return;
            }

            console.log('✅ Session set! User logged in:', data.user?.email);

            // Save terms acceptance date if terms were accepted and not already saved (first time only)
            if (termsAccepted && data.user) {
              const currentMetadata = data.user.user_metadata || {};
              if (!currentMetadata.terms_accepted_at) {
                try {
                  await supabase.auth.updateUser({
                    data: {
                      ...currentMetadata,
                      terms_accepted_at: new Date().toISOString(),
                    },
                  });
                  console.log('✅ Terms acceptance date saved to metadata');
                } catch (updateError) {
                  console.warn('⚠️ Failed to save terms acceptance:', updateError);
                }
              }
            }

            // Navigate based on user state
            console.log('🚀 Navigating after successful auth...');
            // Use replace to prevent going back to callback screen
            router.replace('/setting-up');
            
            // Reset flag after navigation
            setTimeout(() => {
              isHandlingDeepLink = false;
            }, 1000);
          } else {
            console.error('❌ No tokens found in URL. Hash fragment:', url.split('#')[1]?.substring(0, 100));
            isHandlingDeepLink = false;
            // Navigate to auth screen if no tokens
            router.replace('/auth');
          }
        } catch (err) {
          console.error('❌ Error handling auth callback:', err);
          isHandlingDeepLink = false;
          // Navigate to auth screen on error
          router.replace('/auth');
        }
      } else {
        console.log('ℹ️ Not an auth callback, path:', parsedUrl.path);
        isHandlingDeepLink = false;
      }
    };

    const subscription = Linking.addEventListener('url', handleDeepLink);

    // Handle initial URL (app opened via deep link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        console.log('🔗 Initial URL found:', url);
        // Small delay to ensure app is ready
        setTimeout(() => {
          handleDeepLink({ url });
        }, 500);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router]);

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
