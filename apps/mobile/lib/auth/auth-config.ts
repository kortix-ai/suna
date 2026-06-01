/**
 * Auth method / provider configuration.
 *
 * Same contract as the web frontend's NEXT_PUBLIC_AUTH_METHODS /
 * NEXT_PUBLIC_AUTH_PROVIDERS: email auth methods and social providers render
 * only when listed here, never as a hardcoded surface.
 *
 *   EXPO_PUBLIC_AUTH_METHODS   comma list of "magic" / "password"  (default both)
 *   EXPO_PUBLIC_AUTH_PROVIDERS comma list of "google" / "apple"    (default none)
 */

export type AuthMethod = 'magic' | 'password';
export type AuthProvider = 'google' | 'apple';

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const methods = (() => {
  const parsed = parseList(process.env.EXPO_PUBLIC_AUTH_METHODS).filter(
    (s): s is AuthMethod => s === 'magic' || s === 'password',
  );
  return parsed.length ? parsed : (['magic', 'password'] as AuthMethod[]);
})();

const providers = parseList(process.env.EXPO_PUBLIC_AUTH_PROVIDERS).filter(
  (s): s is AuthProvider => s === 'google' || s === 'apple',
);

export const enabledMethods: AuthMethod[] = methods;
export const magicLinkEnabled = methods.includes('magic');
export const passwordEnabled = methods.includes('password');

export const enabledProviders: AuthProvider[] = providers;
export const googleEnabled = providers.includes('google');
export const appleEnabled = providers.includes('apple');
