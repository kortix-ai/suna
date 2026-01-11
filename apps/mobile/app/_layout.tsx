import '@/global.css';

import { ROOBERT_FONTS } from '@/lib/utils/fonts';
import { NAV_THEME } from '@/lib/utils/theme';
import { initializeI18n } from '@/lib/utils/i18n';
import { usePresence } from '@/hooks/usePresence';
import { AuthProvider, LanguageProvider, AgentProvider, BillingProvider, AdvancedFeaturesProvider, TrackingProvider, useAuthContext } from '@/contexts';
import { PresenceProvider } from '@/contexts/PresenceContext';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { ToastProvider } from '@/components/ui/toast-provider';
import { useFonts } from 'expo-font';
import { Stack, SplashScreen, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as Linking from 'expo-linking';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useColorScheme } from 'nativewind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { Platform, LogBox, AppState, AppStateStatus } from 'react-native';
import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated';
import { supabase } from '@/api/supabase';
import * as Updates from 'expo-updates';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { log } from '@/lib/logger';

const THEME_PREFERENCE_KEY = '@theme_preference';

LogBox.ignoreLogs([
  'A props object containing a "key" prop is being spread into JSX',
]);

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

  const queryClientRef = React.useRef(queryClient);
  React.useEffect(() => {
    queryClientRef.current = queryClient;
  }, [queryClient]);

  const [fontsLoaded, fontError] = useFonts(ROOBERT_FONTS);

  useEffect(() => {
    initializeI18n().then(() => {
      log.log('✅ i18n initialized in RootLayout');
      setI18nInitialized(true);
    });
  }, []);

  const themeLoadedRef = useRef(false);

  useEffect(() => {
    let isMounted = true;

    const loadSavedTheme = async () => {
      if (themeLoadedRef.current) return;

      try {
        const saved = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
        if (!isMounted) return;

        themeLoadedRef.current = true;

        if (saved === 'system' || saved === 'dark' || saved === 'light') {
          setColorScheme(saved);
        } else if (!colorScheme) {
          setColorScheme('light');
        }
      } catch {
        if (!isMounted) return;
        if (!colorScheme) {
          setColorScheme('light');
        }
      }
    };

    loadSavedTheme();

    return () => {
      isMounted = false;
    };
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

  // ==========================================
  // OTA UPDATE SYSTEM - Instant Updates
  // ==========================================
  // Uses expo-updates hook for reactive update detection + manual checks
  // 
  // How it works:
  // 1. Native code checks for updates on launch (checkAutomatically: "ON_LOAD")
  // 2. useUpdates() hook detects when update is downloaded
  // 3. We immediately reload to apply the update
  // 4. Also checks on foreground for updates published while app was open
  // ==========================================

  // Track if we've already applied an update this session (prevent reload loops)
  const hasAppliedUpdate = useRef(false);
  const isCheckingUpdate = useRef(false);

  // Use the expo-updates hook to reactively detect when updates are ready
  const {
    isUpdatePending,
    isUpdateAvailable,
    isDownloading,
    downloadedUpdate,
    checkError,
    downloadError,
  } = Updates.useUpdates();

  // Log update state for debugging
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    log.log('📱 OTA State:', {
      isUpdateAvailable,
      isUpdatePending,
      isDownloading,
      hasDownloadedUpdate: !!downloadedUpdate,
      checkError: checkError?.message,
      downloadError: downloadError?.message,
    });
  }, [isUpdateAvailable, isUpdatePending, isDownloading, downloadedUpdate, checkError, downloadError]);

  // Immediately reload when an update is downloaded and pending
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    if (isUpdatePending && !hasAppliedUpdate.current) {
      hasAppliedUpdate.current = true;
      log.log('🚀 OTA: Update pending! Reloading app immediately...');

      // Small delay to ensure any ongoing operations complete
      setTimeout(async () => {
        try {
          await Updates.reloadAsync();
        } catch (error) {
          log.error('❌ OTA: Failed to reload:', error);
          hasAppliedUpdate.current = false;
        }
      }, 100);
    }
  }, [isUpdatePending]);

  // If update is available but not downloading, fetch it
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    if (isUpdateAvailable && !isDownloading && !isUpdatePending && !hasAppliedUpdate.current) {
      log.log('✅ OTA: Update available, fetching...');
      Updates.fetchUpdateAsync().catch((error) => {
        log.error('❌ OTA: Failed to fetch update:', error);
      });
    }
  }, [isUpdateAvailable, isDownloading, isUpdatePending]);

  // Manual check function for foreground and fallback
  const checkAndApplyUpdates = useCallback(async (source: string) => {
    if (__DEV__ || !Updates.isEnabled) return;
    if (isCheckingUpdate.current || hasAppliedUpdate.current) return;

    isCheckingUpdate.current = true;
    log.log(`🔄 OTA: Manual check [${source}]`);

    try {
      const update = await Updates.checkForUpdateAsync();

      if (update.isAvailable) {
        log.log('✅ OTA: Update found, downloading...');
        const fetchResult = await Updates.fetchUpdateAsync();

        if (fetchResult.isNew && !hasAppliedUpdate.current) {
          hasAppliedUpdate.current = true;
          log.log('🚀 OTA: Reloading with new update...');
          await Updates.reloadAsync();
        }
      }
    } catch (error) {
      log.error('❌ OTA: Check failed:', error);
    } finally {
      isCheckingUpdate.current = false;
    }
  }, []);

  // Check for updates when app comes to foreground
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // Delay to let app settle after foregrounding
        setTimeout(() => checkAndApplyUpdates('foreground'), 500);
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [checkAndApplyUpdates]);
  // ==========================================
  // END OTA UPDATE SYSTEM
  // ==========================================

  useEffect(() => {
    let isHandlingDeepLink = false;

    const handleDeepLink = async (event: { url: string }) => {
      if (isHandlingDeepLink) {
        log.log('⏸️ Already handling deep link, skipping...');
        return;
      }
      isHandlingDeepLink = true;

      log.log('🔗 Deep link received:', event.url);

      const url = event.url;
      const parsedUrl = Linking.parse(url);

      log.log('🔍 Parsed URL:', {
        hostname: parsedUrl.hostname,
        path: parsedUrl.path,
        queryParams: parsedUrl.queryParams,
        scheme: parsedUrl.scheme,
      });

      // Check for universal links (https://kortix.com/share/xxx or https://staging.suna.so/share/xxx)
      const isUniversalLink = parsedUrl.scheme === 'https' &&
        (parsedUrl.hostname === 'kortix.com' ||
          parsedUrl.hostname === 'www.kortix.com' ||
          parsedUrl.hostname === 'staging.suna.so');

      // Handle universal link share paths first
      if (isUniversalLink && parsedUrl.path?.startsWith('/share/')) {
        const threadId = parsedUrl.path.replace('/share/', '');
        if (threadId) {
          console.log('📖 Opening shared thread (universal link):', threadId);
          router.push({
            pathname: '/share/[threadId]',
            params: { threadId },
          });
        }
        isHandlingDeepLink = false;
        return;
      }

      // Handle custom scheme: kortix://auth/callback
      if (parsedUrl.hostname === 'auth' && parsedUrl.path === 'callback') {
        log.log('📧 Auth callback received, processing...');

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
                log.log('⚠️ Auth callback error detected:', { error, errorCode, errorDescription });

                // Handle expired OTP/link
                if (errorCode === 'otp_expired' || error === 'access_denied') {
                  const errorMessage = errorDescription
                    ? decodeURIComponent(errorDescription.replace(/\+/g, ' '))
                    : 'This email link has expired. Please request a new one.';

                  // Navigate to auth screen - user can try again there
                  log.log('⚠️ Link expired, redirecting to auth');
                  router.replace('/auth');
                  isHandlingDeepLink = false;
                  return;
                }

                // Other errors - just redirect to auth
                log.error('❌ Auth callback error:', error);
                isHandlingDeepLink = false;
                router.replace('/auth');
                return;
              }
            } catch (hashParseError) {
              log.warn('⚠️ Error parsing hash fragment for errors:', hashParseError);
            }
          }

          // Check for error in query params
          const errorParam = parsedUrl.queryParams?.error;
          if (errorParam) {
            log.error('❌ Auth callback error in query params:', errorParam);
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
            log.log('🔑 Tokens found in query params');
          }

          // Method 2: Hash fragment (legacy Supabase direct redirect)
          if (!access_token || !refresh_token) {
            if (hashFragment) {
              log.log('🔍 Checking hash fragment for tokens...');

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
                log.warn('⚠️ Error parsing hash fragment:', parseError);
                // Try direct extraction
                const accessTokenMatch = hashFragment.match(/access_token=([^&]+)/);
                const refreshTokenMatch = hashFragment.match(/refresh_token=([^&]+)/);
                access_token = access_token || (accessTokenMatch ? decodeURIComponent(accessTokenMatch[1]) : null);
                refresh_token = refresh_token || (refreshTokenMatch ? decodeURIComponent(refreshTokenMatch[1]) : null);
              }
            }
          }

          log.log('🔑 Token extraction result:', {
            hasAccessToken: !!access_token,
            hasRefreshToken: !!refresh_token,
            termsAccepted,
            returnUrl,
          });

          if (access_token && refresh_token) {
            log.log('✅ Setting session with tokens...');

            const { data, error } = await supabase.auth.setSession({
              access_token,
              refresh_token,
            });

            if (error) {
              log.error('❌ Failed to set session:', error);
              isHandlingDeepLink = false;
              router.replace('/auth');
              return;
            }

            log.log('✅ Session set! User logged in:', data.user?.email);

            // Immediately invalidate React Query cache to fetch fresh account state
            log.log('🔄 Invalidating cache to fetch fresh account state');
            queryClientRef.current.invalidateQueries({ queryKey: ['account-state'] });

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
                  log.log('✅ Terms acceptance date saved to metadata');
                } catch (updateError) {
                  log.warn('⚠️ Failed to save terms acceptance:', updateError);
                }
              }
            }

            // Small delay to ensure auth state propagates
            await new Promise(resolve => setTimeout(resolve, 100));

            // Always navigate to splash screen - it will determine the correct destination
            // This ensures smooth transition with loader while checking account state
            log.log('🚀 Navigating to splash screen to determine next step...');
            router.replace('/');

            setTimeout(() => {
              isHandlingDeepLink = false;
            }, 1000);
          } else {
            // No tokens found - could be an error we didn't catch or a malformed URL
            log.warn('⚠️ No tokens found in URL - redirecting to auth');
            isHandlingDeepLink = false;
            router.replace('/auth');
          }
        } catch (err) {
          log.error('❌ Error handling auth callback:', err);
          isHandlingDeepLink = false;
          router.replace('/auth');
        }
      } else if (parsedUrl.path?.startsWith('share/') || parsedUrl.hostname === 'share') {
        // Handle share links: kortix://share/xxx or https://kortix.com/share/xxx
        console.log('🔗 Share link detected');

        // Extract thread ID from path
        let threadId: string | null = null;

        if (parsedUrl.path?.startsWith('share/')) {
          // Path format: share/xxx
          threadId = parsedUrl.path.replace('share/', '');
        } else if (parsedUrl.hostname === 'share' && parsedUrl.path) {
          // Custom scheme format: kortix://share/xxx -> hostname=share, path=xxx
          threadId = parsedUrl.path.replace(/^\//, '');
        }

        if (threadId) {
          console.log('📖 Opening shared thread:', threadId);
          router.push({
            pathname: '/share/[threadId]',
            params: { threadId },
          });
        } else {
          console.warn('⚠️ Share link missing thread ID');
        }

        isHandlingDeepLink = false;
      } else {
        log.log('ℹ️ Not an auth callback, path:', parsedUrl.path);
        isHandlingDeepLink = false;
      }
    };

    const subscription = Linking.addEventListener('url', handleDeepLink);

    // Handle initial URL (app opened via deep link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        log.log('🔗 Initial URL found:', url);
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
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent enabled>
          <TrackingProvider>
            <LanguageProvider>
              <AuthProvider>
                <BillingProvider>
                  <AgentProvider>
                    <AdvancedFeaturesProvider>
                      <PresenceProvider>
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
                                  <Stack.Screen name="worker-config" />
                                  <Stack.Screen
                                    name="share/[threadId]"
                                    options={{
                                      animation: 'slide_from_right',
                                      gestureEnabled: true,
                                    }}
                                  />
                                </Stack>
                              </AuthProtection>
                              <PortalHost />
                            </ThemeProvider>
                          </BottomSheetModalProvider>
                        </ToastProvider>
                      </PresenceProvider>
                    </AdvancedFeaturesProvider>
                  </AgentProvider>
                </BillingProvider>
              </AuthProvider>
            </LanguageProvider>
          </TrackingProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}


function AuthProtection({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const segments = useSegments();
  const router = useRouter();

  const segmentsArray = segments as string[];
  const threadId = (segmentsArray.length > 3 && segmentsArray[2] === 'thread') ? segmentsArray[3] : undefined;
  usePresence(threadId);

  useEffect(() => {
    // Don't do anything while auth is loading
    if (authLoading) return;

    // Wait for segments
    if (!segments || segments.length < 1) return;

    const currentSegment = segments[0] as string | undefined;
    const inAuthGroup = currentSegment === 'auth';
    // Index/splash screen has no segment or empty segment
    const onSplashScreen = !currentSegment;

    // RULE 1: Unauthenticated users can only be on auth or splash screens
    if (!isAuthenticated && !inAuthGroup && !onSplashScreen) {
      log.log('🚫 Unauthenticated user on protected route, redirecting to /auth');
      router.replace('/auth');
      return;
    }

    // RULE 2: Authenticated users should NEVER see auth screens
    // This prevents back navigation/gestures from showing auth to logged-in users
    if (isAuthenticated && inAuthGroup) {
      log.log('🚫 Authenticated user on auth screen, redirecting to /home');
      router.replace('/home');
      return;
    }
  }, [isAuthenticated, authLoading, segments, router]);

  return <>{children}</>;
}
