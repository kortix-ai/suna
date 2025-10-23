import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/api/supabase';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';
import { Platform } from 'react-native';
import type {
  AuthState,
  SignInCredentials,
  SignUpCredentials,
  OAuthProvider,
  PasswordResetRequest,
  AuthError,
} from '@/lib/utils/auth-types';
import type { Session, User, AuthChangeEvent } from '@supabase/supabase-js';

// Configure WebBrowser for OAuth
WebBrowser.maybeCompleteAuthSession();

/**
 * Custom hook for Supabase authentication
 * 
 * Provides authentication state and methods for:
 * - Email/password sign in
 * - Email/password sign up
 * - OAuth providers (Google, GitHub, Apple)
 * - Password reset
 * - Sign out
 * 
 * @example
 * const { signIn, signUp, signOut, user, isAuthenticated } = useAuth();
 */
export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    session: null,
    isLoading: true,
    isAuthenticated: false,
  });

  const [error, setError] = useState<AuthError | null>(null);

  // Initialize auth state
  useEffect(() => {
    console.log('🔐 Initializing auth state');
    
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }: { data: { session: Session | null } }) => {
      console.log('📊 Initial session:', session ? 'Active' : 'None');
      setAuthState({
        user: session?.user ?? null,
        session,
        isLoading: false,
        isAuthenticated: !!session,
      });
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        console.log('🔄 Auth state changed:', _event);
        setAuthState({
          user: session?.user ?? null,
          session,
          isLoading: false,
          isAuthenticated: !!session,
        });
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  /**
   * Sign in with email and password
   */
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

  /**
   * Sign up with email and password
   */
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

  /**
   * Update password (after reset)
   */
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
   * Sign out
   */
  const signOut = useCallback(async () => {
    try {
      console.log('🎯 Sign out attempt');
      setError(null);

      const { error: signOutError } = await supabase.auth.signOut();

      if (signOutError) {
        console.error('❌ Sign out error:', signOutError.message);
        setError({ message: signOutError.message });
        return { success: false, error: signOutError };
      }

      console.log('✅ Sign out successful');
      return { success: true };
    } catch (err: any) {
      console.error('❌ Sign out exception:', err);
      const error = { message: err.message || 'An unexpected error occurred' };
      setError(error);
      return { success: false, error };
    }
  }, []);

  return {
    ...authState,
    error,
    signIn,
    signUp,
    signInWithOAuth,
    resetPassword,
    updatePassword,
    signOut,
  };
}

