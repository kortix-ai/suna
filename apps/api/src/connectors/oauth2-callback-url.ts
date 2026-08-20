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
