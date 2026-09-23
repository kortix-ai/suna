import '@/global.css';

import { ROOBERT_FONTS } from '@/lib/utils/fonts';
import { NAV_THEME, THEME } from '@/lib/utils/theme';
// Initialises i18n synchronously (English, bundled) before the first render.
import '@/lib/utils/i18n';
import { usePresence } from '@/hooks/usePresence';
import {
  AuthProvider,
  LanguageProvider,
  AgentProvider,
  BillingProvider,
  AdvancedFeaturesProvider,
  TrackingProvider,
  useAuthContext,
} from '@/contexts';
import { PresenceProvider } from '@/contexts/PresenceContext';
import { SandboxProvider } from '@/contexts/SandboxContext';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { ThemeProvider } from 'expo-router/react-navigation';
import { PortalHost } from '@rn-primitives/portal';
import { OVERLAY_PORTAL_HOST } from '@/lib/ui/portal-hosts';
import { ToastProvider } from '@/components/kortix/toast-provider';
import { OfflineBanner } from '@/components/kortix/OfflineBanner';
import {
  GlobalUpgradeSheet,
  SandboxUpgradeGateListener,
} from '@/components/billing/GlobalUpgradeSheet';
import { useFonts } from 'expo-font';
import { SplashScreen, Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar, setStatusBarStyle } from 'expo-status-bar';
import { NavigationBar } from 'expo-navigation-bar';
import * as SystemUI from 'expo-system-ui';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { resolveShareLinkUrl } from '@/lib/share-link';
import React, { useEffect, useState } from 'react';
import { useColorScheme } from 'nativewind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { Platform, LogBox, AppState, View } from 'react-native';
import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated';
import { supabase } from '@/api/supabase';
import { log } from '@/lib/logger';
import { useThemeStore } from '@/stores/theme-store';
import { OtaUpdateManager } from '@/components/updates/OtaUpdateManager';
import { subscribeOnlineStatus } from '@/lib/network/use-online-status';
import { installHapticsGate } from '@/lib/haptics';
import { configureKortix } from '@kortix/sdk';
import { API_URL, getAuthToken } from '@/api/config';
import {
  clearWebRegistrationHandoff,
  consumeAuthCallbackState,
  grantWebRegistrationHandoff,
} from '@/lib/auth/callback-state';
import {
  isMobileAuthCallbackUrl,
  isMobileRegistrationHandoffUrl,
} from '@/lib/auth/web-registration-handoff';

// Patch expo-haptics globally so every Haptics.* call across the app respects
// the user's "Haptic Feedback" toggle in Settings → Sounds.
installHapticsGate();

// Wire the SDK's single app-specific seam once at startup, before any screen
// mounts. `backendUrl`/`getToken` reuse mobile's own env resolution and
// Supabase token source (api/config.ts) unchanged — this just injects them
// into @kortix/sdk so `lib/projects/projects-client.ts` and friends can call
// through to `backendApi`/`projects-client` instead of hand-rolling fetch.
configureKortix({
  backendUrl: API_URL,
  getToken: getAuthToken,
  onError: (error, context) => {
    log.error('❌ [kortix-sdk] request failed:', error, context);
  },
});

// React Query has no DOM in React Native: without these listeners every query
// counts as focused and online forever. Focus follows the app being in the
// foreground; online follows the reachability probe the offline banner shows.
focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener('change', (state) => {
    handleFocus(state === 'active');
  });
  return () => subscription.remove();
});
onlineManager.setEventListener((setOnline) => subscribeOnlineStatus(setOnline));

LogBox.ignoreLogs(['A props object containing a "key" prop is being spread into JSX']);

configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

SplashScreen.preventAutoHideAsync();

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
  const { colorScheme } = useColorScheme();
  const router = useRouter();

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 2,
            staleTime: 5 * 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  const queryClientRef = React.useRef(queryClient);
  React.useEffect(() => {
    queryClientRef.current = queryClient;
  }, [queryClient]);

  const [fontsLoaded, fontError] = useFonts(ROOBERT_FONTS);

  useEffect(() => {
    // Restore the persisted theme once; the store applies it to NativeWind.
    void useThemeStore.getState().initialize();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      const activeScheme = colorScheme ?? 'light';
      // Nearest THEME tokens to the old literals (light: --muted L=96.1% is an
      // exact match for F5F5F5; the dark surface token (L=7.8%) is the closest achromatic
      // match to 121215's ~18,18,21 — see the (settings) layout for the same pair).
      const backgroundColor = activeScheme === 'dark' ? THEME.dark.surface : THEME.light.muted;
      SystemUI.setBackgroundColorAsync(backgroundColor);
    }
  }, [colorScheme]);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Keep the status bar visible with icons that contrast with the theme.
  // - iOS resets the bar appearance on suspend/resume, and the declarative
  //   <StatusBar/> only re-applies when the React tree updates.
  // - Android: KeyboardProvider replaces React Native's StatusBarManager with
  //   react-native-keyboard-controller's compat module, which silently drops
  //   setStyle/setHidden while `currentActivity` is null. A call that races
  //   the activity attach is lost, the icons keep Expo Go's previous colour
  //   (white on our light header) and the bar reads as empty on some phones.
  //   Re-applying shortly after mount lands once the activity exists.
  useEffect(() => {
    const desired: 'light' | 'dark' = (colorScheme ?? 'light') === 'dark' ? 'light' : 'dark';
    const apply = () => {
      StatusBar.setHidden(false);
      setStatusBarStyle(desired, false);
      // Android navigation buttons follow the same contrast. Takes effect on
      // 3-button phones once the contrast scrim is off (`enforceContrast:
      // false` in app.json — dev and store builds, not Expo Go).
      if (Platform.OS === 'android') NavigationBar.setStyle(desired);
    };
    apply();
    const retries = [150, 600, 1500].map((ms) => setTimeout(apply, ms));
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') apply();
    });
    return () => {
      retries.forEach(clearTimeout);
      sub.remove();
    };
  }, [colorScheme]);

  useEffect(() => {
    let isHandlingDeepLink = false;

    const handleDeepLink = async (event: { url: string }) => {
      if (isHandlingDeepLink) {
        log.log('⏸️ Already handling deep link, skipping...');
        return;
      }
      isHandlingDeepLink = true;

      const url = event.url;
      const parsedUrl = Linking.parse(url);
      const shareUrl = resolveShareLinkUrl(url);

      log.log('🔗 Deep link received:', {
        hostname: parsedUrl.hostname,
        path: parsedUrl.path,
        scheme: parsedUrl.scheme,
        hasQuery: Boolean(parsedUrl.queryParams && Object.keys(parsedUrl.queryParams).length),
        hasFragment: url.includes('#'),
      });

      // Handle custom scheme callbacks and verified HTTPS universal links.
      if (isMobileAuthCallbackUrl(url)) {
        log.log('📧 Auth callback received, processing...');

        try {
          // Extract hash fragment first to check for errors
          const hashIndex = url.indexOf('#');
          let hashFragment = '';
          if (hashIndex !== -1) {
            hashFragment = url.substring(hashIndex + 1);
          }
          let callbackState =
            typeof parsedUrl.queryParams?.state === 'string' ? parsedUrl.queryParams.state : null;
          if (!callbackState && hashFragment) {
            try {
              callbackState = new URLSearchParams(hashFragment).get('state');
            } catch {
              callbackState = null;
            }
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
          const returnUrl = (parsedUrl.queryParams?.returnUrl as string) || '/';

          // Extract tokens - check query params first (from smart redirect), then hash fragment (legacy)
          let access_token: string | null = null;
          let refresh_token: string | null = null;
          const code =
            typeof parsedUrl.queryParams?.code === 'string' ? parsedUrl.queryParams.code : null;

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
                access_token =
                  access_token ||
                  (accessTokenMatch ? decodeURIComponent(accessTokenMatch[1]) : null);
                refresh_token =
                  refresh_token ||
                  (refreshTokenMatch ? decodeURIComponent(refreshTokenMatch[1]) : null);
              }
            }
          }

          log.log('🔑 Token extraction result:', {
            hasAccessToken: !!access_token,
            hasRefreshToken: !!refresh_token,
            hasCode: !!code,
            termsAccepted,
            returnUrl,
          });

          if ((access_token && refresh_token) || code) {
            const stateOk = await consumeAuthCallbackState(callbackState);
            if (!stateOk) {
              log.warn('⚠️ Auth callback rejected: missing or invalid state');
              isHandlingDeepLink = false;
              router.replace('/auth');
              return;
            }

            if (isMobileRegistrationHandoffUrl(url)) {
              await grantWebRegistrationHandoff();
            }

            let callbackUser: {
              email?: string | null;
              user_metadata?: Record<string, unknown>;
            } | null = null;
            let sessionError: Error | null = null;

            if (access_token && refresh_token) {
              log.log('✅ Setting session with tokens...');
              const { data, error } = await supabase.auth.setSession({
                access_token,
                refresh_token,
              });
              callbackUser = data.user;
              sessionError = error;
            } else if (code) {
              log.log('✅ Exchanging auth callback code...');
              const { data, error } = await supabase.auth.exchangeCodeForSession(code);
              callbackUser = data.user;
              sessionError = error;
            }

            if (sessionError) {
              await clearWebRegistrationHandoff();
              log.error('❌ Failed to establish session:', sessionError);
              isHandlingDeepLink = false;
              router.replace('/auth');
              return;
            }

            log.log('✅ Session set! User logged in:', callbackUser?.email);

            // Immediately invalidate React Query cache to fetch fresh account state
            log.log('🔄 Invalidating cache to fetch fresh account state');
            queryClientRef.current.invalidateQueries({ queryKey: ['account-state'] });

            // Save terms acceptance date if terms were accepted and not already saved
            if (termsAccepted && callbackUser) {
              const currentMetadata = callbackUser.user_metadata || {};
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
            await new Promise((resolve) => setTimeout(resolve, 100));

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
          await clearWebRegistrationHandoff();
          log.error('❌ Error handling auth callback:', err);
          isHandlingDeepLink = false;
          router.replace('/auth');
        }
      } else if (shareUrl) {
        // No in-app share screen: open the web share page in the in-app
        // browser. `+native-intent.ts` keeps the router from navigating.
        log.log('🔗 Share link received, opening in the in-app browser');
        isHandlingDeepLink = false;
        WebBrowser.openBrowserAsync(shareUrl, {
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        }).catch((error) => {
          log.warn('⚠️ Failed to open share link:', error);
        });
      } else {
        log.log('ℹ️ Not an auth callback, path:', parsedUrl.path);
        isHandlingDeepLink = false;
      }
    };

    const subscription = Linking.addEventListener('url', handleDeepLink);

    // Handle initial URL (app opened via deep link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        log.log('🔗 Initial URL found');
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

  const activeColorScheme = colorScheme ?? 'light';

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent enabled>
          <TrackingProvider>
            <LanguageProvider>
              <AuthProvider>
                <SandboxProvider>
                  <BillingProvider>
                    <AgentProvider>
                      <AdvancedFeaturesProvider>
                        <PresenceProvider>
                          <ToastProvider>
                            <BottomSheetModalProvider>
                              <ThemeProvider value={NAV_THEME[activeColorScheme]}>
                                <StatusBar
                                  style={activeColorScheme === 'dark' ? 'light' : 'dark'}
                                />
                                <View className="flex-1">
                                  <AuthProtection>
                                    {/* Every stack is the native Stack with the platform default
                                        push/pop on iOS and Android. `index` only redirects, so it
                                        does not animate. */}
                                    <Stack
                                      screenOptions={{
                                        headerShown: false,
                                        gestureEnabled: true,
                                      }}>
                                      <Stack.Screen name="index" options={{ animation: 'none' }} />
                                      <Stack.Screen
                                        name="(tabs)"
                                        options={{ gestureEnabled: false }}
                                      />
                                      <Stack.Screen
                                        name="auth"
                                        options={{ gestureEnabled: false }}
                                      />
                                      <Stack.Screen
                                        name="projects/[id]"
                                        // Back never leaves a project: no swipe-back.
                                        // Only the project menu's All projects opens the
                                        // list (ProjectLeftDrawer). The project stack has
                                        // no swipe-back either: its left edge opens the
                                        // project drawer on every project page.
                                        options={{ gestureEnabled: false }}
                                      />
                                      <Stack.Screen
                                        name="(settings)"
                                        options={{
                                          presentation: 'card',
                                          fullScreenGestureEnabled: true,
                                        }}
                                      />
                                      <Stack.Screen name="plans" />
                                      <Stack.Screen name="billing" />
                                      <Stack.Screen
                                        name="accounts/[id]"
                                        options={{ fullScreenGestureEnabled: true }}
                                      />
                                    </Stack>
                                  </AuthProtection>
                                </View>
                                <OtaUpdateManager />
                                <SandboxUpgradeGateListener />
                                <GlobalUpgradeSheet />
                                <PortalHost />
                                <OfflineBanner />
                              </ThemeProvider>
                            </BottomSheetModalProvider>
                            {/* Above every bottom sheet: dropdowns opened from inside a sheet. */}
                            <PortalHost name={OVERLAY_PORTAL_HOST} />
                          </ToastProvider>
                        </PresenceProvider>
                      </AdvancedFeaturesProvider>
                    </AgentProvider>
                  </BillingProvider>
                </SandboxProvider>
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
  const threadId =
    segmentsArray.length > 3 && segmentsArray[2] === 'thread' ? segmentsArray[3] : undefined;
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
      log.log('🚫 Authenticated user on auth screen, redirecting to the last project');
      router.replace('/');
      return;
    }
  }, [isAuthenticated, authLoading, segments, router]);

  return <>{children}</>;
}
