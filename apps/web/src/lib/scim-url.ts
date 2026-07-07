/**
 * Build the SCIM 2.0 base URL an IdP (Okta / Azure AD / JumpCloud) is pointed
 * at. The IdP calls this URL directly — server-to-server, never through the web
 * app — so it MUST be an absolute, publicly-reachable origin.
 *
 * We take only the ORIGIN of the app's configured backend URL and append the
 * SCIM path: SCIM is mounted at the API root (`/scim/v2`), NOT under the `/v1`
 * API prefix, so a backend like `https://api.kortix.com/v1` still yields
 * `https://api.kortix.com/scim/v2/...`.
 *
 * `backendUrl` may legitimately be a root-relative proxy path (e.g. `/v1`) in
 * same-origin deployments — there we can't derive a public origin, so we return
 * the relative path and the caller keeps its "prepend your API origin" hint.
 */
export function buildScimBaseUrl(accountId: string, backendUrl: string | null | undefined): string {
  const path = `/scim/v2/accounts/${accountId}`;
  if (backendUrl && /^https?:\/\//i.test(backendUrl)) {
    try {
      return new URL(backendUrl).origin + path;
    } catch {
      /* malformed URL — fall through to the relative path */
    }
  }
  return path;
}

/**
 * Whether a value is an absolute http(s) URL. Lets the UI drop the
 * "prepend your API origin" hint once the base URL is already absolute.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
