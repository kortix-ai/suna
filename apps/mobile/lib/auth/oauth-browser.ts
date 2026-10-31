import type { OAuthProvider } from '@/lib/utils/auth-types';

/**
 * Query params Supabase forwards to the provider. `select_account` makes Google
 * show its account list every time. Without it, the shared browser session
 * continues silently with the last account: a user who signed out to switch
 * accounts, or whose account has no Kortix access, cannot pick another one.
 */
export function oauthQueryParams(provider: OAuthProvider): Record<string, string> | undefined {
  return provider === 'google' ? { prompt: 'select_account' } : undefined;
}

/**
 * iOS: `ASWebAuthenticationSession.prefersEphemeralWebBrowserSession`. An
 * ephemeral session has no Safari cookies, so Google shows an empty sign-in
 * form instead of the accounts on the device. SSO stays ephemeral: it opens web
 * auth on kortix.com, which would sign out or hand back a Safari Kortix login.
 */
export function prefersEphemeralAuthSession(provider: OAuthProvider | 'sso'): boolean {
  return provider === 'sso';
}
