/**
 * useOAuthSignIn — Google / Apple sign-in state for an auth screen.
 *
 * Used by the welcome screen, which stays mounted under the email screen in
 * the auth stack. A rejected brand-new OAuth account arrives once through
 * `oauthRejection`; it is consumed only while the screen is focused, so the
 * error shows when the user is looking at the provider buttons.
 */

import * as React from 'react';
import { useIsFocused } from 'expo-router/react-navigation';

import { useAuthContext } from '@/contexts';

export type OAuthProvider = 'google' | 'apple';

const PROVIDER_NAME: Record<OAuthProvider, string> = { google: 'Google', apple: 'Apple' };

export function useOAuthSignIn() {
  const { signInWithOAuth, oauthRejection, clearOauthRejection } = useAuthContext();
  const isFocused = useIsFocused();
  const [pending, setPending] = React.useState<OAuthProvider | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!oauthRejection || !isFocused) return;
    setPending(null);
    setError(oauthRejection);
    clearOauthRejection();
  }, [oauthRejection, clearOauthRejection, isFocused]);

  const signInWith = React.useCallback(
    async (provider: OAuthProvider) => {
      setPending(provider);
      setError(null);
      try {
        const res = await signInWithOAuth(provider);
        // Existing users are routed away by the auth layout; a brand-new
        // account comes back through `oauthRejection` instead.
        if (!res?.success && res?.error?.message && !/cancel/i.test(res.error.message)) {
          setError(res.error.message);
        }
      } catch (err: any) {
        setError(err?.message || `${PROVIDER_NAME[provider]} sign-in failed.`);
      } finally {
        setPending(null);
      }
    },
    [signInWithOAuth]
  );

  const clearError = React.useCallback(() => setError(null), []);

  return { pending, error, clearError, signInWith };
}
