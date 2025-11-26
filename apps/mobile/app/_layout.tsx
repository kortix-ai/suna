import '@/global.css';

import { ROOBERT_FONTS } from '@/lib/utils/fonts';
import { NAV_THEME } from '@/lib/utils/theme';
import { initializeI18n } from '@/lib/utils/i18n';
import { AuthProvider, LanguageProvider, AgentProvider, BillingProvider, AdvancedFeaturesProvider, TrackingProvider, useAuthContext } from '@/contexts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { ToastProvider } from '@/components/ui/toast-provider';
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
          // Extract hash fragment first to check for errors
          const hashIndex = url.indexOf('#');
          let hashFragment = '';
          if (hashIndex !== -1) {
            hashFragment = url.substring(hashIndex + 1);
          }

          // Check for errors in hash fragment first
          if (hashFragment) {
            try {
              const hashParams = new URLSearchParams(hashFragment);
              const error = hashParams.get('error');
              const errorCode = hashParams.get('error_code');
              const errorDescription = hashParams.get('error_description');
              
              if (error) {
                console.log('⚠️ Auth callback error detected:', { error, errorCode, errorDescription });
                
                // Handle expired OTP/link
                if (errorCode === 'otp_expired' || error === 'access_denied') {
                  const errorMessage = errorDescription 
                    ? decodeURIComponent(errorDescription.replace(/\+/g, ' '))
                    : 'This email link has expired. Please request a new one.';
                  
                  // Navigate to auth screen - user can try again there
                  console.log('⚠️ Link expired, redirecting to auth');
                  router.replace('/auth');
                  isHandlingDeepLink = false;
                  return;
                }
                
                // Other errors - just redirect to auth
                console.error('❌ Auth callback error:', error);
                isHandlingDeepLink = false;
                router.replace('/auth');
                return;
              }
            } catch (hashParseError) {
              console.warn('⚠️ Error parsing hash fragment for errors:', hashParseError);
            }
          }

          // Check for error in query params
          const errorParam = parsedUrl.queryParams?.error;
          if (errorParam) {
            console.error('❌ Auth callback error in query params:', errorParam);
            isHandlingDeepLink = false;
            router.replace('/auth');
            return;
          }

          // Check for terms_accepted in query params
          const termsAccepted = parsedUrl.queryParams?.terms_accepted === 'true';
          // Default to index (splash) screen - it will route based on user state
          // Only use explicit returnUrl if provided (e.g., from web redirect)
          const returnUrl = parsedUrl.queryParams?.returnUrl as string || '/';
          
          // Extract tokens - check query params first (from smart redirect), then hash fragment (legacy)
          let access_token: string | null = null;
          let refresh_token: string | null = null;
          
          // Method 1: Query params (from smart redirect page)
          if (parsedUrl.queryParams?.access_token && parsedUrl.queryParams?.refresh_token) {
            access_token = parsedUrl.queryParams.access_token as string;
            refresh_token = parsedUrl.queryParams.refresh_token as string;
            console.log('🔑 Tokens found in query params');
          }
          
          // Method 2: Hash fragment (legacy Supabase direct redirect)
          if (!access_token || !refresh_token) {
            if (hashFragment) {
              console.log('🔍 Checking hash fragment for tokens...');
            
              try {
                const hashParams = new URLSearchParams(hashFragment);
                access_token = access_token || hashParams.get('access_token');
                refresh_token = refresh_token || hashParams.get('refresh_token');
                
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
                access_token = access_token || (accessTokenMatch ? decodeURIComponent(accessTokenMatch[1]) : null);
                refresh_token = refresh_token || (refreshTokenMatch ? decodeURIComponent(refreshTokenMatch[1]) : null);
              }
            }
          }
          
          console.log('🔑 Token extraction result:', { 
              hasAccessToken: !!access_token, 
            hasRefreshToken: !!refresh_token,
            termsAccepted,
            returnUrl,
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
              router.replace('/auth');
              return;
            }

                      console.log('✅ Session set! User logged in:', data.user?.email);

            // Save terms acceptance date if terms were accepted and not already saved
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

            // Small delay to ensure auth state propagates
            await new Promise(resolve => setTimeout(resolve, 100));

            // Always navigate to splash screen - it will determine the correct destination
            // This ensures smooth transition with loader while checking account state
            console.log('🚀 Navigating to splash screen to determine next step...');
            router.replace('/');
            
            setTimeout(() => {
              isHandlingDeepLink = false;
            }, 1000);
          } else {
            // No tokens found - could be an error we didn't catch or a malformed URL
            console.warn('⚠️ No tokens found in URL - redirecting to auth');
            isHandlingDeepLink = false;
            router.replace('/auth');
          }
        } catch (err) {
          console.error('❌ Error handling auth callback:', err);
          isHandlingDeepLink = false;
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
            <AuthProvider>
              <BillingProvider>
                <AgentProvider>
                  <AdvancedFeaturesProvider>
                    <ToastProvider>
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
                              <Stack.Screen 
                                name="home" 
                                options={{ 
                                  gestureEnabled: false,
                                }} 
                              />
                              <Stack.Screen 
                                name="auth" 
                                options={{ 
                                  gestureEnabled: false,
                                  animation: 'fade',
                                }} 
                              />
                              <Stack.Screen name="trigger-detail" />
                            </Stack>
                          </AuthProtection>
                          <PortalHost />
                        </ThemeProvider>
                      </BottomSheetModalProvider>
                    </ToastProvider>
                  </AdvancedFeaturesProvider>
                </AgentProvider>
              </BillingProvider>
            </AuthProvider>
          </LanguageProvider>
        </TrackingProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}


function AuthProtection({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // Don't do anything while auth is loading
    if (authLoading) return;
    
    // Wait for segments
    if (!segments || segments.length < 1) return;

    const currentSegment = segments[0] as string | undefined;
    const inAuthGroup = currentSegment === 'auth';
    // Index/splash screen has no segment or empty segment
    const onSplashScreen = !currentSegment;

    // Simple rule: Unauthenticated users can only be on auth or splash screens
    if (!isAuthenticated && !inAuthGroup && !onSplashScreen) {
      console.log('🚫 Unauthenticated user on protected route, redirecting to /auth');
      router.replace('/auth');
    }
  }, [isAuthenticated, authLoading, segments, router]);

  return <>{children}</>;
}
