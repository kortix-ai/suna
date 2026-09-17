import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, SUPABASE_AUTH_STORAGE_KEY } from '@/api/supabase';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as QueryParams from 'expo-auth-session/build/QueryParams';
import { Platform, AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { shouldUseRevenueCat } from '@/lib/billing/provider';
import { consumeAuthCallbackState, createAuthCallbackRedirect } from '@/lib/auth/callback-state';
import { admitMobileOAuthSession } from '@/lib/auth/mobile-admission';
import { parsePersistedSession, sessionForNullAuthResult } from '@/lib/auth/persisted-session';
import { keysToClear } from '@/lib/auth/sign-out-keys';
import { applyProfileLocale } from '@/lib/utils/i18n';
import { withDeadline } from '@/lib/utils/with-deadline';
import { useTabStore } from '@/stores/tab-store';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useLastProjectStore } from '@/stores/last-project-store';
import { useSelectedProjectStore } from '@/stores/selected-project-store';
import { useTabScreenshotStore } from '@/stores/tab-screenshot-store';

let useTracking: any = null;
try {
  const TrackingModule = require('@/contexts/TrackingContext');
  useTracking = TrackingModule.useTracking;
} catch (e) {
  log.warn('⚠️ TrackingContext not available');
}
import type {
  AuthState,
  SignInCredentials,
  SignUpCredentials,
  OAuthProvider,
  PasswordResetRequest,
  AuthError,
} from '@/lib/utils/auth-types';
import type { Session, AuthChangeEvent } from '@supabase/supabase-js';
import { log, setLoggerUserId } from '@/lib/logger';

/**
 * Sign-out: reset the in-memory stores that hold the previous user's data.
 * Clearing storage alone is not enough: a store keeps its state in memory and
 * writes it back on its next update, so the next user to sign in without a
 * relaunch would see the previous user's tabs and queue. Device preferences
 * (theme, sounds, notifications) are not reset.
 */
function resetUserStores() {
  useTabStore.getState().reset();
  useMessageQueueStore.getState().reset();
  useCurrentAccountStore.getState().reset();
  useLastProjectStore.getState().reset();
  useSelectedProjectStore.getState().reset();
  // Also deletes the screenshot files.
  useTabScreenshotStore.getState().clear();
}

// Complete any pending auth sessions (required for web)
WebBrowser.maybeCompleteAuthSession();

/**
 * Upper bound on the initial session restore. `getSession()` waits on a token
 * refresh that auth-js retries for up to 30 s; past this deadline the persisted
 * session decides the first screen and `onAuthStateChange` corrects it.
 */
const AUTH_RESTORE_DEADLINE_MS = 8_000;
const AUTH_RESTORE_TIMED_OUT = Symbol('auth-restore-timed-out');

/**
 * RevenueCat's module constructs a native event emitter on import, so it is
 * required only when billing uses it.
 */
function initializeRevenueCat(
  ...args: Parameters<typeof import('@/lib/billing/revenuecat').initializeRevenueCat>
) {
  const revenueCat: typeof import('@/lib/billing/revenuecat') = require('@/lib/billing/revenuecat');
  return revenueCat.initializeRevenueCat(...args);
}

/** The raw session supabase-js persisted, or null when absent or unreadable. */
async function readStoredSessionRaw(): Promise<string | null> {
  if (!SUPABASE_AUTH_STORAGE_KEY) return null;
  try {
    return await AsyncStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);
  } catch (error) {
    log.warn('⚠️ Could not read the persisted session:', error);
    return null;
  }
}

function redactAuthUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const redact = (params: URLSearchParams) => {
      for (const key of ['access_token', 'refresh_token', 'code', 'state']) {
        if (params.has(key)) params.set(key, '[redacted]');
      }
    };
    redact(parsed.searchParams);
    if (parsed.hash.startsWith('#')) {
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      redact(hashParams);
      parsed.hash = hashParams.toString();
    }
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function isExpectedAuthCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'kortix:' && parsed.hostname === 'auth' && parsed.pathname === '/callback'
    );
  } catch {
    return false;
  }
}

function extractAuthCallbackState(url: string): string | null {
  try {
    const parsed = new URL(url);
    const queryState = parsed.searchParams.get('state');
    if (queryState) return queryState;
    if (parsed.hash.startsWith('#')) {
      return new URLSearchParams(parsed.hash.slice(1)).get('state');
    }
  } catch {}
  return null;
}

/**
 * Extract tokens from OAuth callback URL
 * Handles both hash fragment (#) and query params (?)
 */
function extractTokensFromUrl(url: string): {
  access_token: string | null;
  refresh_token: string | null;
} {
  try {
    // Try hash fragment first (Supabase implicit flow)
    const hashIndex = url.indexOf('#');
    if (hashIndex !== -1) {
      const hashFragment = url.substring(hashIndex + 1);
      const params = new URLSearchParams(hashFragment);
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');
      if (access_token && refresh_token) {
        return { access_token, refresh_token };
      }
    }

    // Try query params (PKCE flow or custom redirect)
    const { params } = QueryParams.getQueryParams(url);
    return {
      access_token: params.access_token || null,
      refresh_token: params.refresh_token || null,
    };
  } catch (e) {
    log.error('Failed to extract tokens from URL:', e);
    return { access_token: null, refresh_token: null };
  }
}

/**
 * Create session from OAuth callback URL
 */
async function createSessionFromUrl(url: string) {
  const { access_token, refresh_token } = extractTokensFromUrl(url);

  if (!access_token || !refresh_token) {
    log.log('⚠️ No tokens found in URL');
    return null;
  }

  log.log('✅ Tokens extracted, setting session...');
  const { data, error } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });

  if (error) {
    log.error('❌ Failed to set session:', error);
    throw error;
  }

  return data.session;
}

export function useAuth() {
  const queryClient = useQueryClient();
  const trackingState = useTracking ? useTracking() : { canTrack: false, isLoading: false };
  const { canTrack, isLoading: trackingLoading } = trackingState;
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    session: null,
    isLoading: true,
    isAuthenticated: false,
  });

  const [error, setError] = useState<AuthError | null>(null);
  const [oauthRejection, setOauthRejection] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const initializedUserIdRef = useRef<string | null>(null);
  const initializedCanTrackRef = useRef<boolean | null>(null);
  const oauthSessionActiveRef = useRef<boolean>(false);
  const mobileOAuthAdmissionPendingRef = useRef<boolean>(false);
  // True once a real auth answer (restore or auth event) has set the state, so
  // the stalled-restore fallback never overwrites it.
  const authResolvedRef = useRef<boolean>(false);
  // Bumped by every auth state write. A write that awaited a storage read
  // drops its result when a newer write happened meanwhile.
  const authSeqRef = useRef<number>(0);

  // Initialize session once on mount
  useEffect(() => {
    let mounted = true;

    const applyRestoredSession = async (restored: Session | null) => {
      const seq = ++authSeqRef.current;
      // A null restore after a retryable refresh failure keeps the stored session.
      const session =
        restored ?? sessionForNullAuthResult('RESTORE', await readStoredSessionRaw());
      if (!mounted || seq !== authSeqRef.current) return;
      authResolvedRef.current = true;

      // Update logger with user ID
      setLoggerUserId(session?.user?.id || null);

      setAuthState({
        user: session?.user ?? null,
        session,
        isLoading: false,
        isAuthenticated: !!session,
      });
      void applyProfileLocale(session?.user);

      if (session?.user && shouldUseRevenueCat()) {
        // Only initialize if user changed or canTrack changed from false to true
        const shouldInitialize =
          initializedUserIdRef.current !== session.user.id ||
          (canTrack && initializedCanTrackRef.current !== canTrack);

        if (shouldInitialize) {
          try {
            await initializeRevenueCat(session.user.id, session.user.email, canTrack);
            initializedUserIdRef.current = session.user.id;
            initializedCanTrackRef.current = canTrack;
          } catch (error) {
            log.warn('⚠️ Failed to initialize RevenueCat:', error);
          }
        }
      }
    };

    // The restore stalled or failed: decide from the session on disk. A stored
    // session opens the app while the refresh continues; none means signed out.
    const applyPersistedSession = async () => {
      const session = parsePersistedSession(await readStoredSessionRaw());
      if (!mounted || authResolvedRef.current) return;
      setLoggerUserId(session?.user?.id || null);
      setAuthState({
        user: session?.user ?? null,
        session,
        isLoading: false,
        isAuthenticated: !!session,
      });
      void applyProfileLocale(session?.user);
    };

    const restore: Promise<{ data: { session: Session | null } }> = supabase.auth.getSession();
    withDeadline(restore, AUTH_RESTORE_DEADLINE_MS, AUTH_RESTORE_TIMED_OUT)
      .then((result) => {
        if (result !== AUTH_RESTORE_TIMED_OUT) return applyRestoredSession(result.data.session);
        log.warn('⚠️ Session restore exceeded the deadline; using the persisted session');
        // A late restore still wins over the fallback.
        restore
          .then(({ data: { session } }) => applyRestoredSession(session))
          .catch(() => {});
        return applyPersistedSession();
      })
      .catch((error: unknown) => {
        log.warn('⚠️ Session restore failed; using the persisted session:', error);
        return applyPersistedSession();
      });

    return () => {
      mounted = false;
    };
  }, []); // Only run once on mount

  // Handle auth state changes and canTrack changes
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      async (_event: AuthChangeEvent, session: Session | null) => {
        // Only log significant auth events, not every state change
        if (_event === 'SIGNED_IN' || _event === 'SIGNED_OUT' || _event === 'TOKEN_REFRESHED') {
          log.log('🔄 Auth state changed:', _event);
        }

        // Bumped before any await: a restore that is still reading storage must
        // not write its (possibly signed-in) result after this event, including
        // while the OAuth admission check below runs.
        const seq = ++authSeqRef.current;

        // Login-only gate for direct mobile OAuth sign-up only. Password and magic
        // link sign-in, plus session hydration, must not consult the new-user window
        // — a user who registered separately on the web can sign in immediately.
        if (_event === 'SIGNED_IN' && mobileOAuthAdmissionPendingRef.current) {
          mobileOAuthAdmissionPendingRef.current = false;
          if (!(await admitMobileOAuthSession(session))) {
            log.warn(
              '🚫 New direct OAuth user on mobile — signing out (register on the web first)'
            );
            setOauthRejection('No account found. Create an account on the web first.');
            await supabase.auth.signOut().catch(() => {});
            return;
          }
        }

        if (!session && _event !== 'SIGNED_OUT') {
          // INITIAL_SESSION is null after a retryable refresh failure while the
          // refresh token is still stored: the user stays signed in.
          session = sessionForNullAuthResult(_event, await readStoredSessionRaw());
          if (seq !== authSeqRef.current) return;
        }

        // Update logger with user ID
        setLoggerUserId(session?.user?.id || null);

        authResolvedRef.current = true;
        setAuthState({
          user: session?.user ?? null,
          session,
          isLoading: false,
          isAuthenticated: !!session,
        });
        void applyProfileLocale(session?.user);

        if (session?.user && shouldUseRevenueCat() && _event === 'SIGNED_IN') {
          // Only initialize if user changed or canTrack changed from false to true
          const shouldInitialize =
            initializedUserIdRef.current !== session.user.id ||
            (canTrack && initializedCanTrackRef.current !== canTrack);

          if (shouldInitialize) {
            try {
              await initializeRevenueCat(session.user.id, session.user.email, canTrack);
              initializedUserIdRef.current = session.user.id;
              initializedCanTrackRef.current = canTrack;
            } catch (error) {
              log.warn('⚠️ Failed to initialize RevenueCat:', error);
            }
          }
        } else if (_event === 'SIGNED_OUT') {
          initializedUserIdRef.current = null;
          initializedCanTrackRef.current = null;
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [canTrack]); // Only depend on canTrack, not trackingLoading

  // Handle canTrack changes for already-initialized RevenueCat
  useEffect(() => {
    if (!authState.user || !shouldUseRevenueCat() || !canTrack) {
      return;
    }

    // If RevenueCat was initialized with canTrack=false but now it's true, update it
    if (
      initializedUserIdRef.current === authState.user.id &&
      initializedCanTrackRef.current !== canTrack
    ) {
      initializeRevenueCat(authState.user.id, authState.user.email, canTrack)
        .then(() => {
          initializedCanTrackRef.current = canTrack;
        })
        .catch((error) => {
          log.warn('⚠️ Failed to update RevenueCat tracking:', error);
        });
    }
  }, [canTrack, authState.user]); // Update when canTrack or user changes

  const signIn = useCallback(
    async ({ email, password }: SignInCredentials) => {
      try {
        log.log('🎯 Sign in attempt:', email);
        setError(null);
        setAuthState((prev) => ({ ...prev, isLoading: true }));

        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (signInError) {
          log.error('❌ Sign in error:', signInError.message);
          setError({ message: signInError.message, status: signInError.status });
          setAuthState((prev) => ({ ...prev, isLoading: false }));
          return { success: false, error: signInError };
        }

        log.log('✅ Sign in successful:', data.user?.email);

        // Immediately invalidate React Query cache to fetch fresh account state
        log.log('🔄 Invalidating cache to fetch fresh account state');
        queryClient.invalidateQueries({ queryKey: ['account-state'] });

        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: true, data };
      } catch (err: any) {
        log.error('❌ Sign in exception:', err);
        const error = { message: err.message || 'An unexpected error occurred' };
        setError(error);
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error };
      }
    },
    [queryClient]
  );

  const signUp = useCallback(
    async ({ email, password, fullName }: SignUpCredentials) => {
      try {
        log.log('🎯 Sign up attempt:', email);
        setError(null);
        setAuthState((prev) => ({ ...prev, isLoading: true }));

        const normalizedEmail = email.trim().toLowerCase();

        const { error: signUpError } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            data: fullName ? { full_name: fullName } : undefined,
            emailRedirectTo: await createAuthCallbackRedirect(),
          },
        });

        const alreadyExists =
          !!signUpError &&
          (/already registered|already exists/i.test(signUpError.message) ||
            signUpError.status === 422);

        if (signUpError && !alreadyExists) {
          log.error('❌ Sign up error:', signUpError.message);
          setError({ message: signUpError.message, status: signUpError.status });
          setAuthState((prev) => ({ ...prev, isLoading: false }));
          return { success: false, error: signUpError };
        }

        // Mirror web signUpWithPassword: immediately establish a session. When
        // Supabase email confirmations are off (local default) this signs the
        // user in; when on (cloud) it reports "email not confirmed" and we
        // surface that instead.
        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });

        if (signInError) {
          if (/not confirmed|email_not_confirmed/i.test(signInError.message)) {
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: true, requiresEmailConfirmation: true };
          }
          if (alreadyExists) {
            const error = {
              message: 'An account with this email already exists. Try signing in instead.',
            };
            setError(error);
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: false, error };
          }
          log.error('❌ Sign up sign-in error:', signInError.message);
          setError({ message: signInError.message, status: signInError.status });
          setAuthState((prev) => ({ ...prev, isLoading: false }));
          return { success: false, error: signInError };
        }

        log.log('✅ Sign up successful:', signInData.user?.email);
        queryClient.invalidateQueries({ queryKey: ['account-state'] });
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: true, data: signInData };
      } catch (err: any) {
        log.error('❌ Sign up exception:', err);
        const error = { message: err.message || 'An unexpected error occurred' };
        setError(error);
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error };
      }
    },
    [queryClient]
  );

  /**
   * Sign in with OAuth provider (Supabase standard implementation)
   *
   * Uses Supabase's OAuth flow:
   * - iOS Google: WebBrowser.openAuthSessionAsync (ASWebAuthenticationSession)
   * - Android Google: Linking.openURL (external browser) + deep link callback
   * - Android Other: Linking.openURL (external browser) + deep link callback
   * - Apple: Native Apple Authentication on iOS
   */
  const signInWithOAuth = useCallback(async (provider: OAuthProvider) => {
    try {
      log.log('🎯 OAuth sign in attempt:', provider);
      setError(null);
      setAuthState((prev) => ({ ...prev, isLoading: true }));

      // ========================================
      // NATIVE APPLE SIGN-IN (iOS only)
      // Uses expo-apple-authentication for the best UX
      // ========================================
      if (provider === 'apple' && Platform.OS === 'ios') {
        log.log('🍎 Using native Apple Authentication for iOS');
        mobileOAuthAdmissionPendingRef.current = true;

        try {
          const credential = await AppleAuthentication.signInAsync({
            requestedScopes: [
              AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
              AppleAuthentication.AppleAuthenticationScope.EMAIL,
            ],
          });

          log.log('✅ Apple credential received:', credential.user);

          // Sign in to Supabase with Apple ID token
          const { data, error: appleError } = await supabase.auth.signInWithIdToken({
            provider: 'apple',
            token: credential.identityToken!,
          });

          if (appleError) {
            mobileOAuthAdmissionPendingRef.current = false;
            log.error('❌ Apple sign in error:', appleError.message);
            setError({ message: appleError.message });
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: false, error: appleError };
          }

          log.log('✅ Apple sign in successful');

          // Immediately invalidate React Query cache to fetch fresh account state
          log.log('🔄 Invalidating cache to fetch fresh account state');
          queryClient.invalidateQueries({ queryKey: ['account-state'] });

          setAuthState((prev) => ({ ...prev, isLoading: false }));
          return { success: true, data };
        } catch (appleErr: any) {
          mobileOAuthAdmissionPendingRef.current = false;
          if (appleErr.code === 'ERR_REQUEST_CANCELED') {
            log.log('⚠️ Apple sign in cancelled by user');
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: false, error: { message: 'Sign in cancelled' } };
          }
          throw appleErr;
        }
      }

      // ========================================
      // SUPABASE OAUTH FLOW (Google and other providers)
      // Uses web-based OAuth for all providers:
      // - iOS Google: WebBrowser.openAuthSessionAsync (ASWebAuthenticationSession)
      // - Android Google: External browser via Linking.openURL (reliable callback handling)
      // - Other providers: Platform-specific browser handling
      // ========================================

      const redirectTo = await createAuthCallbackRedirect();

      log.log('📊 Redirect URL:', redirectTo, 'Platform:', Platform.OS);

      // Get OAuth URL from Supabase
      const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });

      if (oauthError) {
        log.error('❌ OAuth error:', oauthError.message);
        setError({ message: oauthError.message });
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error: oauthError };
      }

      if (!data?.url) {
        log.error('❌ No OAuth URL returned');
        const error = { message: 'Failed to get authentication URL' };
        setError(error);
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error };
      }

      log.log('🌐 Opening OAuth URL:', data.url);

      // Prevent multiple simultaneous OAuth sessions
      if (oauthSessionActiveRef.current) {
        log.warn('⚠️ OAuth session already in progress');
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return {
          success: false,
          error: { message: 'An authentication session is already in progress' },
        };
      }

      try {
        oauthSessionActiveRef.current = true;
        mobileOAuthAdmissionPendingRef.current = true;

        // ========================================
        // ANDROID: Use external browser via Linking.openURL
        // Chrome Custom Tabs don't properly handle custom URL scheme redirects
        // The external browser (Chrome, Firefox, etc.) works correctly for all OAuth providers
        // ========================================
        if (Platform.OS === 'android') {
          log.log('🤖 Android: Opening OAuth in external browser');

          // Open OAuth URL in external browser
          await Linking.openURL(data.url);

          // Wait for the app to return from browser and check for session
          // The deep link handler in _layout.tsx will process the callback
          log.log('⏳ Android: Waiting for OAuth callback...');

          return new Promise((resolve) => {
            let hasResolved = false;
            let appStateSubscription: any = null;

            // Timeout after 2 minutes
            const timeout = setTimeout(() => {
              if (!hasResolved) {
                hasResolved = true;
                appStateSubscription?.remove();
                log.log('❌ Android: OAuth timeout');
                setAuthState((prev) => ({ ...prev, isLoading: false }));
                oauthSessionActiveRef.current = false;
                mobileOAuthAdmissionPendingRef.current = false;
                resolve({
                  success: false,
                  error: { message: 'Authentication timed out. Please try again.' },
                });
              }
            }, 120000);

            const handleAppStateChange = async (nextAppState: AppStateStatus) => {
              log.log('📱 Android: AppState changed to:', nextAppState);

              // When app comes back to foreground
              if (nextAppState === 'active' && !hasResolved) {
                // Give deep link handler time to process the callback
                await new Promise((r) => setTimeout(r, 1500));

                // Check if session was set by deep link handler in _layout.tsx
                const {
                  data: { session },
                } = await supabase.auth.getSession();

                if (session) {
                  hasResolved = true;
                  clearTimeout(timeout);
                  appStateSubscription?.remove();
                  log.log('✅ Android: Session found - OAuth successful:', session.user?.email);

                  // Immediately invalidate React Query cache to fetch fresh account state
                  log.log('🔄 Invalidating cache to fetch fresh account state');
                  queryClient.invalidateQueries({ queryKey: ['account-state'] });

                  setAuthState((prev) => ({ ...prev, isLoading: false }));
                  oauthSessionActiveRef.current = false;
                  resolve({ success: true, data: session });
                } else {
                  // User might have returned without completing auth
                  // Wait a bit more in case deep link is still processing
                  await new Promise((r) => setTimeout(r, 1000));
                  const {
                    data: { session: retrySession },
                  } = await supabase.auth.getSession();

                  if (retrySession) {
                    hasResolved = true;
                    clearTimeout(timeout);
                    appStateSubscription?.remove();
                    log.log('✅ Android: Session found on retry - OAuth successful');

                    // Immediately invalidate React Query cache to fetch fresh account state
                    log.log('🔄 Invalidating cache to fetch fresh account state');
                    queryClient.invalidateQueries({ queryKey: ['account-state'] });

                    setAuthState((prev) => ({ ...prev, isLoading: false }));
                    oauthSessionActiveRef.current = false;
                    resolve({ success: true, data: retrySession });
                  } else {
                    hasResolved = true;
                    clearTimeout(timeout);
                    appStateSubscription?.remove();
                    log.log('❌ Android: No session after returning from browser');
                    setAuthState((prev) => ({ ...prev, isLoading: false }));
                    oauthSessionActiveRef.current = false;
                    mobileOAuthAdmissionPendingRef.current = false;
                    resolve({
                      success: false,
                      error: { message: 'Authentication was not completed. Please try again.' },
                    });
                  }
                }
              }
            };

            appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
          });
        }

        // ========================================
        // iOS: Use WebBrowser.openAuthSessionAsync
        // ASWebAuthenticationSession works perfectly with custom URL schemes
        // ========================================
        log.log('🍎 iOS: Opening OAuth in auth session');

        await WebBrowser.maybeCompleteAuthSession();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo, {
          preferEphemeralSession: true,
          showInRecents: true,
        });

        log.log('📊 WebBrowser result type:', result.type);

        if (result.type === 'success' && result.url) {
          const url = result.url;
          log.log('✅ OAuth redirect received:', redactAuthUrl(url));

          if (
            !isExpectedAuthCallbackUrl(url) ||
            !(await consumeAuthCallbackState(extractAuthCallbackState(url)))
          ) {
            const stateError = {
              message: 'Invalid authentication callback. Please try signing in again.',
            };
            log.warn('⚠️ OAuth callback rejected: invalid redirect or state');
            setError(stateError);
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            oauthSessionActiveRef.current = false;
            mobileOAuthAdmissionPendingRef.current = false;
            return { success: false, error: stateError };
          }

          // Check for access_token in URL fragment (implicit flow)
          if (url.includes('access_token=')) {
            log.log('✅ Access token found in URL, setting session');

            // Extract tokens from URL fragment
            const hashParams = new URLSearchParams(url.split('#')[1] || '');
            const accessToken = hashParams.get('access_token');
            const refreshToken = hashParams.get('refresh_token');

            if (accessToken && refreshToken) {
              // Set the session with the tokens
              const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken,
              });

              if (sessionError) {
                log.error('❌ Session error:', sessionError.message);
                setError({ message: sessionError.message });
                setAuthState((prev) => ({ ...prev, isLoading: false }));
                oauthSessionActiveRef.current = false;
                mobileOAuthAdmissionPendingRef.current = false;
                return { success: false, error: sessionError };
              }

              log.log('✅ OAuth sign in successful');

              // Immediately invalidate React Query cache to fetch fresh account state
              log.log('🔄 Invalidating cache to fetch fresh account state');
              queryClient.invalidateQueries({ queryKey: ['account-state'] });

              setAuthState((prev) => ({ ...prev, isLoading: false }));
              oauthSessionActiveRef.current = false;
              return { success: true, data: sessionData };
            }
          }

          // Check for code in query params (PKCE flow)
          const urlObj = new URL(url);
          const code = urlObj.searchParams.get('code');

          if (code) {
            log.log('✅ OAuth code received, exchanging for session');

            const { data: sessionData, error: sessionError } =
              await supabase.auth.exchangeCodeForSession(code);

            if (sessionError) {
              log.error('❌ Session exchange error:', sessionError.message);
              setError({ message: sessionError.message });
              setAuthState((prev) => ({ ...prev, isLoading: false }));
              oauthSessionActiveRef.current = false;
              mobileOAuthAdmissionPendingRef.current = false;
              return { success: false, error: sessionError };
            }

            log.log('✅ OAuth sign in successful');

            // Immediately invalidate React Query cache to fetch fresh account state
            log.log('🔄 Invalidating cache to fetch fresh account state');
            queryClient.invalidateQueries({ queryKey: ['account-state'] });

            setAuthState((prev) => ({ ...prev, isLoading: false }));
            oauthSessionActiveRef.current = false;
            return { success: true, data: sessionData };
          }
        } else if (result.type === 'cancel' || result.type === 'dismiss') {
          log.log('⚠️ OAuth cancelled/dismissed by user');
          setAuthState((prev) => ({ ...prev, isLoading: false }));
          oauthSessionActiveRef.current = false;
          mobileOAuthAdmissionPendingRef.current = false;
          return { success: false, error: { message: 'Sign in cancelled' } };
        }

        log.log('❌ OAuth failed - unexpected result type:', result.type);
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        oauthSessionActiveRef.current = false;
        mobileOAuthAdmissionPendingRef.current = false;
        return { success: false, error: { message: 'Authentication failed' } };
      } catch (sessionErr: any) {
        // Reset session flag on error within try block
        oauthSessionActiveRef.current = false;
        mobileOAuthAdmissionPendingRef.current = false;
        throw sessionErr;
      }
    } catch (err: any) {
      log.error('❌ OAuth exception:', err);

      // Reset session flag on error
      oauthSessionActiveRef.current = false;
      mobileOAuthAdmissionPendingRef.current = false;

      // Handle specific WebBrowser auth session error
      if (err.message?.includes('invalid state') || err.message?.includes('redirect handler')) {
        log.warn('⚠️ WebBrowser auth session conflict, attempting cleanup...');
        try {
          await WebBrowser.maybeCompleteAuthSession();
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (cleanupError) {
          log.warn('⚠️ Cleanup attempt failed:', cleanupError);
        }
      }

      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      setAuthState((prev) => ({ ...prev, isLoading: false }));
      return { success: false, error };
    }
  }, []);

  /**
   * Sign in with magic link (passwordless)
   * Auto-creates account if it doesn't exist
   * Uses kortix:// deep link - works when app is installed
   */
  const signInWithMagicLink = useCallback(
    async ({ email, acceptedTerms }: { email: string; acceptedTerms?: boolean }) => {
      try {
        log.log('🎯 Magic link sign in request:', email);
        setError(null);

        const emailRedirectTo = await createAuthCallbackRedirect({
          terms_accepted: acceptedTerms ? 'true' : undefined,
        });

        log.log('📱 Magic link redirect URL:', emailRedirectTo);

        const { error: magicLinkError, data } = await supabase.auth.signInWithOtp({
          email: email.trim().toLowerCase(),
          options: {
            emailRedirectTo,
            shouldCreateUser: false, // Login only — new accounts are created on the web
          },
        });

        // Only a redirect-related error gets the redirect hint. A network
        // failure ("Network request timed out") used to be logged as a rejected
        // redirect, which pointed debugging at the wrong layer.
        if (magicLinkError && /redirect/i.test(magicLinkError.message)) {
          log.error('❌ Supabase rejected redirect URL:', {
            message: magicLinkError.message,
            status: magicLinkError.status,
            attemptedUrl: emailRedirectTo,
            hint: 'Add kortix://** to Auth → Redirect URLs (local: supabase/config.toml additional_redirect_urls)',
          });
        }

        if (magicLinkError) {
          log.error('❌ Magic link error:', magicLinkError.message);
          setError({ message: magicLinkError.message });
          return { success: false, error: magicLinkError };
        }

        // If user accepted terms and magic link was sent, update metadata after successful auth
        // Note: This will be handled when the user clicks the magic link and signs in
        // For now, we store it in the signup data which will be saved when account is created

        log.log('✅ Magic link email sent');
        return { success: true };
      } catch (err: any) {
        log.error('❌ Magic link exception:', err);
        const error = { message: err.message || 'An unexpected error occurred' };
        setError(error);
        return { success: false, error };
      }
    },
    []
  );

  /**
   * Request password reset email
   */
  const resetPassword = useCallback(async ({ email }: PasswordResetRequest) => {
    try {
      log.log('🎯 Password reset request:', email);
      setError(null);

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'kortix://auth/reset-password',
      });

      if (resetError) {
        log.error('❌ Password reset error:', resetError.message);
        setError({ message: resetError.message });
        return { success: false, error: resetError };
      }

      log.log('✅ Password reset email sent');
      return { success: true };
    } catch (err: any) {
      log.error('❌ Password reset exception:', err);
      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      return { success: false, error };
    }
  }, []);

  const updatePassword = useCallback(async (newPassword: string) => {
    try {
      log.log('🎯 Password update attempt');
      setError(null);

      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        log.error('❌ Password update error:', updateError.message);
        setError({ message: updateError.message });
        return { success: false, error: updateError };
      }

      log.log('✅ Password updated successfully');
      return { success: true };
    } catch (err: any) {
      log.error('❌ Password update exception:', err);
      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      return { success: false, error };
    }
  }, []);

  /**
   * Sign out - Best practice implementation
   *
   * 1. Attempts global sign out (server + local)
   * 2. Falls back to local-only if global fails
   * 3. Clears every AsyncStorage key except device preferences (theme,
   *    language, onboarding cache — see lib/auth/sign-out-keys), including the
   *    Supabase session keys as a failsafe
   * 4. Forces React state update
   *
   * Note: Onboarding status is stored in user_metadata (backend), so it persists
   * across devices and logins. AsyncStorage cache is kept for faster checks.
   *
   * Always succeeds from UI perspective to prevent stuck states
   */
  const signOut = useCallback(async () => {
    // Prevent multiple simultaneous sign out attempts
    if (isSigningOut) {
      log.log('⚠️ Sign out already in progress, ignoring duplicate call');
      return { success: false, error: { message: 'Sign out already in progress' } };
    }

    const clearUserStorage = async () => {
      try {
        const keys = keysToClear(await AsyncStorage.getAllKeys());
        if (keys.length > 0) {
          log.log(`🧹 Clearing ${keys.length} storage keys`);
          await AsyncStorage.multiRemove(keys);
        }
        log.log('✅ Storage cleared (device preferences kept)');
      } catch (error) {
        log.warn('⚠️  Failed to clear storage:', error);
      }
    };

    // Runs after storage is cleared.
    const forceSignOutState = () => {
      // Drop any in-flight stored-session read so it cannot restore the state.
      authSeqRef.current += 1;
      authResolvedRef.current = true;
      resetUserStores();
      setLoggerUserId(null); // Clear logger user ID
      setAuthState({
        user: null,
        session: null,
        isLoading: false,
        isAuthenticated: false,
      });
      setError(null);
    };

    try {
      log.log('🎯 Sign out initiated');
      setIsSigningOut(true);

      if (shouldUseRevenueCat()) {
        try {
          const { logoutRevenueCat } = require('@/lib/billing/revenuecat');
          await logoutRevenueCat();
          log.log('✅ RevenueCat logout completed - subscription detached from device');
        } catch (rcError) {
          log.warn('⚠️  RevenueCat logout failed (non-critical):', rcError);
        }
      }

      const { error: globalError } = await supabase.auth.signOut({ scope: 'global' });

      if (globalError) {
        log.warn('⚠️  Global sign out failed:', globalError.message);

        const { error: localError } = await supabase.auth.signOut({ scope: 'local' });

        if (localError) {
          log.warn('⚠️  Local sign out also failed:', localError.message);
        }
      }

      await clearUserStorage();

      log.log('🗑️  Clearing React Query cache...');
      queryClient.clear();
      log.log('✅ React Query cache cleared');

      forceSignOutState();

      log.log('✅ Sign out completed successfully - all data cleared');
      setIsSigningOut(false);
      return { success: true };
    } catch (error: any) {
      log.error('❌ Sign out exception:', error);

      await clearUserStorage();
      queryClient.clear();
      forceSignOutState();

      log.log('✅ Sign out completed (with errors handled) - all data cleared');
      setIsSigningOut(false);
      return { success: true };
    }
  }, [queryClient, isSigningOut]);

  const clearOauthRejection = useCallback(() => setOauthRejection(null), []);

  // Stable identity: AuthProvider passes this object as the context value, and
  // a fresh object every render re-renders every consumer.
  return useMemo(
    () => ({
      ...authState,
      error,
      oauthRejection,
      clearOauthRejection,
      isSigningOut,
      signIn,
      signUp,
      signInWithOAuth,
      signInWithMagicLink,
      resetPassword,
      updatePassword,
      signOut,
    }),
    [
      authState,
      error,
      oauthRejection,
      clearOauthRejection,
      isSigningOut,
      signIn,
      signUp,
      signInWithOAuth,
      signInWithMagicLink,
      resetPassword,
      updatePassword,
      signOut,
    ]
  );
}
