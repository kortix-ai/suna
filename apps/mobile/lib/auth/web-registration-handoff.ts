const MOBILE_CALLBACK_FLAG = 'mobile_callback';
const KORTIX_CALLBACK_HOSTS = new Set([
  'kortix.com',
  'www.kortix.com',
  'staging.kortix.com',
]);

/**
 * Open web auth with proof that this registration began in the installed app.
 * The opaque state is generated and persisted by callback-state.ts.
 */
export function buildMobileRegistrationUrl(baseUrl: string, state: string): string {
  const url = new URL('/auth', baseUrl);
  url.searchParams.set(MOBILE_CALLBACK_FLAG, '1');
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Accept native callbacks from either the custom scheme or the verified Kortix
 * HTTPS universal-link route. HTTPS must carry the explicit mobile marker so
 * ordinary web callbacks cannot create a native session.
 */
export function isMobileAuthCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === 'kortix:' &&
      parsed.hostname === 'auth' &&
      parsed.pathname === '/callback'
    ) {
      return true;
    }

    return (
      parsed.protocol === 'https:' &&
      KORTIX_CALLBACK_HOSTS.has(parsed.hostname) &&
      parsed.pathname === '/auth/callback' &&
      parsed.searchParams.get(MOBILE_CALLBACK_FLAG) === '1'
    );
  } catch {
    return false;
  }
}

export function isMobileRegistrationHandoffUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === 'kortix:' &&
      parsed.hostname === 'auth' &&
      parsed.pathname === '/callback'
    ) {
      return parsed.searchParams.get(MOBILE_CALLBACK_FLAG) === '1';
    }
    return (
      parsed.protocol === 'https:' &&
      KORTIX_CALLBACK_HOSTS.has(parsed.hostname) &&
      parsed.pathname === '/auth/callback' &&
      parsed.searchParams.get(MOBILE_CALLBACK_FLAG) === '1'
    );
  } catch {
    return false;
  }
}
