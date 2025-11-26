import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/api/supabase';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';
import { Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { initializeRevenueCat, shouldUseRevenueCat } from '@/lib/billing';

let useTracking: any = null;
try {
  const TrackingModule = require('@/contexts/TrackingContext');
  useTracking = TrackingModule.useTracking;
} catch (e) {
  console.warn('⚠️ TrackingContext not available');
}
import type {
  AuthState,
  SignInCredentials,
  SignUpCredentials,
  OAuthProvider,
  PasswordResetRequest,
  AuthError,
} from '@/lib/utils/auth-types';
import type { Session, User, AuthChangeEvent } from '@supabase/supabase-js';

WebBrowser.maybeCompleteAuthSession();

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
  const [isSigningOut, setIsSigningOut] = useState(false);
  const initializedUserIdRef = useRef<string | null>(null);
  const initializedCanTrackRef = useRef<boolean | null>(null);

  // Initialize session once on mount
  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data: { session } }: { data: { session: Session | null } }) => {
      if (!mounted) return;

      setAuthState({
        user: session?.user ?? null,
        session,
        isLoading: false,
        isAuthenticated: !!session,
      });

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
          console.warn('⚠️ Failed to initialize RevenueCat:', error);
          }
        }
      }
    });

    return () => {
      mounted = false;
    };
  }, []); // Only run once on mount

  // Handle auth state changes and canTrack changes
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event: AuthChangeEvent, session: Session | null) => {
        // Only log significant auth events, not every state change
        if (_event === 'SIGNED_IN' || _event === 'SIGNED_OUT' || _event === 'TOKEN_REFRESHED') {
          console.log('🔄 Auth state changed:', _event);
        }
        
        setAuthState({
          user: session?.user ?? null,
          session,
          isLoading: false,
          isAuthenticated: !!session,
        });

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
            console.warn('⚠️ Failed to initialize RevenueCat:', error);
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
    if (initializedUserIdRef.current === authState.user.id && initializedCanTrackRef.current !== canTrack) {
      initializeRevenueCat(authState.user.id, authState.user.email, canTrack)
        .then(() => {
          initializedCanTrackRef.current = canTrack;
        })
        .catch((error) => {
          console.warn('⚠️ Failed to update RevenueCat tracking:', error);
        });
    }
  }, [canTrack, authState.user]); // Update when canTrack or user changes

  const signIn = useCallback(async ({ email, password }: SignInCredentials) => {
    try {
      console.log('🎯 Sign in attempt:', email);
      setError(null);
      setAuthState((prev) => ({ ...prev, isLoading: true }));

      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        console.error('❌ Sign in error:', signInError.message);
        setError({ message: signInError.message, status: signInError.status });
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error: signInError };
      }

      console.log('✅ Sign in successful:', data.user?.email);
      setAuthState((prev) => ({ ...prev, isLoading: false }));
      return { success: true, data };
    } catch (err: any) {
      console.error('❌ Sign in exception:', err);
      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      setAuthState((prev) => ({ ...prev, isLoading: false }));
      return { success: false, error };
    }
  }, []);

  const signUp = useCallback(
    async ({ email, password, fullName }: SignUpCredentials) => {
      try {
        console.log('🎯 Sign up attempt:', email);
        setError(null);
        setAuthState((prev) => ({ ...prev, isLoading: true }));

        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
            },
            emailRedirectTo: 'kortix://auth/callback',
          },
        });

        if (signUpError) {
          console.error('❌ Sign up error:', signUpError.message);
          setError({ message: signUpError.message, status: signUpError.status });
          setAuthState((prev) => ({ ...prev, isLoading: false }));
          return { success: false, error: signUpError };
        }

        console.log('✅ Sign up successful:', data.user?.email);
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: true, data };
      } catch (err: any) {
        console.error('❌ Sign up exception:', err);
        const error = { message: err.message || 'An unexpected error occurred' };
        setError(error);
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error };
      }
    },
    []
  );

  /**
   * Sign in with OAuth provider
   */
  const signInWithOAuth = useCallback(async (provider: OAuthProvider) => {
    try {
      console.log('🎯 OAuth sign in attempt:', provider);
      setError(null);
      setAuthState((prev) => ({ ...prev, isLoading: true }));

      // Handle Apple Sign In with native module on iOS
      if (provider === 'apple' && Platform.OS === 'ios') {
        console.log('🍎 Using native Apple Authentication for iOS');
        
        try {
          const credential = await AppleAuthentication.signInAsync({
            requestedScopes: [
              AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
              AppleAuthentication.AppleAuthenticationScope.EMAIL,
            ],
          });

          console.log('✅ Apple credential received:', credential.user);

          // Sign in to Supabase with Apple ID token
          const { data, error: appleError } = await supabase.auth.signInWithIdToken({
            provider: 'apple',
            token: credential.identityToken!,
          });

          if (appleError) {
            console.error('❌ Apple sign in error:', appleError.message);
            setError({ message: appleError.message });
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: false, error: appleError };
          }

          console.log('✅ Apple sign in successful');
          setAuthState((prev) => ({ ...prev, isLoading: false }));
          return { success: true, data };
        } catch (appleErr: any) {
          if (appleErr.code === 'ERR_REQUEST_CANCELED') {
            console.log('⚠️ Apple sign in cancelled by user');
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: false, error: { message: 'Sign in cancelled' } };
          }
          throw appleErr;
        }
      }

      // Force mobile redirect URL (not web Site URL)
      const redirectTo = 'kortix://auth/callback';

      console.log('📊 Redirect URL:', redirectTo);

      // Get OAuth URL from Supabase
      const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });

      if (oauthError) {
        console.error('❌ OAuth error:', oauthError.message);
        setError({ message: oauthError.message });
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error: oauthError };
      }

      if (!data?.url) {
        console.error('❌ No OAuth URL returned');
        const error = { message: 'Failed to get authentication URL' };
        setError(error);
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error };
      }

      console.log('🌐 Opening OAuth URL in browser');
      
      // Open OAuth URL in in-app browser
      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        redirectTo
      );

      console.log('📊 WebBrowser result:', result);

      if (result.type === 'success' && result.url) {
        const url = result.url;
        console.log('✅ OAuth redirect received:', url);
        
        // Check for access_token in URL fragment (implicit flow)
        if (url.includes('access_token=')) {
          console.log('✅ Access token found in URL, setting session');
          
          // Extract tokens from URL fragment
          const hashParams = new URLSearchParams(url.split('#')[1] || '');
          const accessToken = hashParams.get('access_token');
          const refreshToken = hashParams.get('refresh_token');
          
          if (accessToken && refreshToken) {
            // Set the session with the tokens
            const { data: sessionData, error: sessionError } = 
              await supabase.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken,
              });

            if (sessionError) {
              console.error('❌ Session error:', sessionError.message);
              setError({ message: sessionError.message });
              setAuthState((prev) => ({ ...prev, isLoading: false }));
              return { success: false, error: sessionError };
            }

            console.log('✅ OAuth sign in successful');
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: true, data: sessionData };
          }
        }
        
        // Check for code in query params (PKCE flow)
        const urlObj = new URL(url);
        const code = urlObj.searchParams.get('code');
        
        if (code) {
          console.log('✅ OAuth code received, exchanging for session');
          
          const { data: sessionData, error: sessionError } = 
            await supabase.auth.exchangeCodeForSession(code);

          if (sessionError) {
            console.error('❌ Session exchange error:', sessionError.message);
            setError({ message: sessionError.message });
            setAuthState((prev) => ({ ...prev, isLoading: false }));
            return { success: false, error: sessionError };
          }

          console.log('✅ OAuth sign in successful');
          setAuthState((prev) => ({ ...prev, isLoading: false }));
          return { success: true, data: sessionData };
        }
      } else if (result.type === 'cancel') {
        console.log('⚠️ OAuth cancelled by user');
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error: { message: 'Sign in cancelled' } };
      }

      console.log('❌ OAuth failed - no tokens found');
      setAuthState((prev) => ({ ...prev, isLoading: false }));
      return { success: false, error: { message: 'Authentication failed' } };
    } catch (err: any) {
      console.error('❌ OAuth exception:', err);
      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      setAuthState((prev) => ({ ...prev, isLoading: false }));
      return { success: false, error };
    }
  }, []);

  /**
   * Sign in with magic link (passwordless)
   * Auto-creates account if it doesn't exist
   * Goes directly to mobile deep link - no frontend redirect needed
   */
  const signInWithMagicLink = useCallback(async ({ email, acceptedTerms }: { email: string; acceptedTerms?: boolean }) => {
    try {
      console.log('🎯 Magic link sign in request:', email);
      setError(null);
      setAuthState((prev) => ({ ...prev, isLoading: true }));

      // Build deep link URL directly - no frontend redirect needed for mobile
      const params = new URLSearchParams();
      if (acceptedTerms) {
        params.set('terms_accepted', 'true');
      }
      
      const emailRedirectTo = `kortix://auth/callback${params.toString() ? `?${params.toString()}` : ''}`;

      console.log('📱 Mobile magic link redirect URL:', emailRedirectTo);

      const { error: magicLinkError, data } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo,
          shouldCreateUser: true, // Auto-create account if doesn't exist
        },
      });

      if (magicLinkError) {
        console.error('❌ Supabase rejected redirect URL:', {
          message: magicLinkError.message,
          status: magicLinkError.status,
          attemptedUrl: emailRedirectTo,
          hint: 'Make sure kortix://auth/callback is in Supabase Dashboard → Auth → Redirect URLs',
        });
      }

      if (magicLinkError) {
        console.error('❌ Magic link error:', magicLinkError.message);
        setError({ message: magicLinkError.message });
        setAuthState((prev) => ({ ...prev, isLoading: false }));
        return { success: false, error: magicLinkError };
      }

      // If user accepted terms and magic link was sent, update metadata after successful auth
      // Note: This will be handled when the user clicks the magic link and signs in
      // For now, we store it in the signup data which will be saved when account is created

      console.log('✅ Magic link email sent');
      setAuthState((prev) => ({ ...prev, isLoading: false }));
      return { success: true };
    } catch (err: any) {
      console.error('❌ Magic link exception:', err);
      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      setAuthState((prev) => ({ ...prev, isLoading: false }));
      return { success: false, error };
    }
  }, []);

  /**
   * Request password reset email
   */
  const resetPassword = useCallback(async ({ email }: PasswordResetRequest) => {
    try {
      console.log('🎯 Password reset request:', email);
      setError(null);

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'kortix://auth/reset-password',
      });

      if (resetError) {
        console.error('❌ Password reset error:', resetError.message);
        setError({ message: resetError.message });
        return { success: false, error: resetError };
      }

      console.log('✅ Password reset email sent');
      return { success: true };
    } catch (err: any) {
      console.error('❌ Password reset exception:', err);
      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      return { success: false, error };
    }
  }, []);


  const updatePassword = useCallback(async (newPassword: string) => {
    try {
      console.log('🎯 Password update attempt');
      setError(null);

      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        console.error('❌ Password update error:', updateError.message);
        setError({ message: updateError.message });
        return { success: false, error: updateError };
      }

      console.log('✅ Password updated successfully');
      return { success: true };
    } catch (err: any) {
      console.error('❌ Password update exception:', err);
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
   * 3. Manually clears all Supabase keys from AsyncStorage as failsafe
   * 4. Forces React state update
   * 5. Clears onboarding status for next user
   * 
   * Always succeeds from UI perspective to prevent stuck states
   */
  const signOut = useCallback(async () => {
    // Prevent multiple simultaneous sign out attempts
    if (isSigningOut) {
      console.log('⚠️ Sign out already in progress, ignoring duplicate call');
      return { success: false, error: { message: 'Sign out already in progress' } };
    }

    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    
    /**
     * Helper to clear all Supabase-related keys from AsyncStorage
     * This is a nuclear option that ensures complete sign out
     */
    const clearSupabaseStorage = async () => {
      try {
        const allKeys = await AsyncStorage.getAllKeys();
        const supabaseKeys = allKeys.filter((key: string) => 
          key.includes('supabase') || 
          key.includes('sb-') || 
          key.includes('-auth-token')
        );
        
        if (supabaseKeys.length > 0) {
          console.log(`🗑️  Removing ${supabaseKeys.length} Supabase keys from storage`);
          await AsyncStorage.multiRemove(supabaseKeys);
        }
      } catch (error) {
        console.warn('⚠️  Failed to clear Supabase storage:', error);
      }
    };

    const clearAppData = async () => {
      try {
        const allKeys = await AsyncStorage.getAllKeys()
        const appDataKeys = allKeys.filter((key: string) => 
          key.startsWith('@') && 
          !key.includes('language') &&
          !key.includes('theme') &&
          !key.includes('onboarding_completed')
        );
        
        console.log(`🧹 Clearing ${appDataKeys.length} app data keys:`, appDataKeys);
        
        if (appDataKeys.length > 0) {
          await AsyncStorage.multiRemove(appDataKeys);
        }
        
        console.log('✅ All app data cleared (except preferences and onboarding status)');
      } catch (error) {
        console.warn('⚠️  Failed to clear app data:', error);
      }
    };

    const forceSignOutState = () => {
      setAuthState({
        user: null,
        session: null,
        isLoading: false,
        isAuthenticated: false,
      });
      setError(null);
    };

    try {
      console.log('🎯 Sign out initiated');
      setIsSigningOut(true);
      
      if (shouldUseRevenueCat()) {
        try {
          const { logoutRevenueCat } = require('@/lib/billing/revenuecat');
          await logoutRevenueCat();
          console.log('✅ RevenueCat logout completed - subscription detached from device');
        } catch (rcError) {
          console.warn('⚠️  RevenueCat logout failed (non-critical):', rcError);
        }
      }

      const { error: globalError } = await supabase.auth.signOut({ scope: 'global' });

      if (globalError) {
        console.warn('⚠️  Global sign out failed:', globalError.message);
        
        const { error: localError } = await supabase.auth.signOut({ scope: 'local' });
        
        if (localError) {
          console.warn('⚠️  Local sign out also failed:', localError.message);
        }
      }

      await clearSupabaseStorage();

      await clearAppData();

      console.log('🗑️  Clearing React Query cache...');
      queryClient.clear();
      console.log('✅ React Query cache cleared');

      forceSignOutState();

      console.log('✅ Sign out completed successfully - all data cleared');
      setIsSigningOut(false);
      return { success: true };

    } catch (error: any) {
      console.error('❌ Sign out exception:', error);

      await clearSupabaseStorage().catch(() => {});
      await clearAppData().catch(() => {});
      queryClient.clear();
      forceSignOutState();

      console.log('✅ Sign out completed (with errors handled) - all data cleared');
      setIsSigningOut(false);
      return { success: true };
    }
  }, [queryClient, isSigningOut]);

  return {
    ...authState,
    error,
    isSigningOut,
    signIn,
    signUp,
    signInWithOAuth,
    signInWithMagicLink,
    resetPassword,
    updatePassword,
    signOut,
  };
}

