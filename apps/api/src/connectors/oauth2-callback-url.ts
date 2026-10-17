/**
 * The one public redirect URI Kortix registers with third-party authorization
 * servers. It is derived from the PUBLIC API origin (`KORTIX_URL`), never from
 * the incoming request: behind the load balancer the API sees
 * `http://<internal-host>/…`, and an authorization server rejects a redirect_uri
 * that does not byte-match the registered one.
 */
export const NATIVE_OAUTH2_CALLBACK_PATH = '/v1/connectors/oauth2/callback';

function publicApiOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const pathname = url.pathname
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

export function nativeOAuth2CallbackUrl(
  requestUrl: string,
  publicApiUrl: string | undefined,
): string {
  const base = publicApiOrigin(publicApiUrl);
  if (base) return `${base}${NATIVE_OAUTH2_CALLBACK_PATH}`;
  return new URL(NATIVE_OAUTH2_CALLBACK_PATH, requestUrl).href;
}

const CALLBACK_ERROR_HINTS: Record<string, string> = {
  invalid_state: 'this sign-in link was already used or has expired. Start the sign-in again.',
};

/**
 * What the public callback answers. A sign-in started with no return page
 * (`kortix connectors authorize` without `--success-redirect`) used to answer
 * "OAuth2 authorization failed" even when it connected.
 */
export function nativeOAuth2CallbackResponse(result: {
  ok: boolean;
  redirectUri: string | null;
  errorCode?: string;
}): { status: 200 | 400; body: string } | { status: 302; location: string } {
  if (!result.redirectUri) {
    if (result.ok) {
      return { status: 200, body: 'Connected. You can close this tab and return to Kortix.' };
    }
    const code = result.errorCode ?? 'authorization_failed';
    const hint = CALLBACK_ERROR_HINTS[code];
    return {
      status: 400,
      body: `OAuth2 authorization failed (${code})${hint ? `: ${hint}` : '.'}`,
    };
  }
  const redirect = new URL(result.redirectUri);
  redirect.searchParams.set('oauth2', result.ok ? 'connected' : 'error');
  if (result.errorCode) redirect.searchParams.set('oauth2_error', result.errorCode);
  return { status: 302, location: redirect.href };
}
