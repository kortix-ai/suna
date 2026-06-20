const MOBILE_CALLBACK_FLAG = 'mobile_callback';
const KORTIX_CALLBACK_HOSTS = new Set([
  'kortix.com',
  'www.kortix.com',
  'staging.kortix.com',
]);

type MobileSessionHandoffInput = {
  origin: string;
  state: string | null | undefined;
  accessToken: string | null | undefined;
  refreshToken: string | null | undefined;
};

/**
 * Build the final native-session handoff after web authentication.
 *
 * Production mobile flows use the verified HTTPS app-link route first, so the
 * OS can open the installed app without relying on an async custom-scheme
 * navigation. Local development keeps the existing custom-scheme callback.
 */
export function buildMobileSessionHandoffUrl({
  origin,
  state,
  accessToken,
  refreshToken,
}: MobileSessionHandoffInput): string | null {
  if (!state || !accessToken || !refreshToken) return null;

  let url: URL;
  try {
    const candidate = new URL(origin);
    url = candidate.protocol === 'https:' && KORTIX_CALLBACK_HOSTS.has(candidate.hostname)
      ? new URL('/auth/callback', candidate)
      : new URL('kortix://auth/callback');
  } catch {
    url = new URL('kortix://auth/callback');
  }

  url.searchParams.set(MOBILE_CALLBACK_FLAG, '1');
  url.searchParams.set('state', state);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('refresh_token', refreshToken);
  return url.toString();
}
