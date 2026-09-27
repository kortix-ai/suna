/**
 * Where an external link opens (COR-151) — one rule for the whole app:
 * - a Kortix link (`kortix.com` or any subdomain: docs, support, pages, …)
 *   opens in the in-app browser (`WebBrowser.openBrowserAsync`), so the user
 *   stays in the app;
 * - a third-party link (GitHub, a markdown link to any other site) opens in
 *   the system browser (`Linking.openURL`), where the user's own sessions and
 *   password manager live.
 *
 * `openLink` (`./open-link.ts`) applies it. Pure: no React Native imports, so
 * bun tests run it directly. Parsed with a regex, not `URL`, because React
 * Native's built-in `URL` has no `hostname`.
 */

export type LinkTarget = 'in-app' | 'system';

/** `scheme://authority…` — the authority is everything up to `/ ? #`. */
const HTTP_URL = /^(https?):\/\/([^/?#]*)/i;

/** The registrable domain every Kortix surface lives under. */
const KORTIX_DOMAIN = 'kortix.com';

/**
 * The lowercase host of an http(s) URL, without userinfo, port, or a trailing
 * dot; `null` for any other scheme or a malformed URL.
 */
export function httpHost(url: string): string | null {
  const match = HTTP_URL.exec(url.trim());
  if (!match) return null;
  // `user:pass@host:port` → `host`. The LAST `@` ends the userinfo, so
  // `https://kortix.com@evil.example` resolves to `evil.example`.
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  const host = authority.replace(/:\d*$/, '').replace(/\.$/, '').toLowerCase();
  return host || null;
}

/** True for `kortix.com` and every subdomain of it, never a look-alike. */
export function isKortixHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === KORTIX_DOMAIN || h.endsWith(`.${KORTIX_DOMAIN}`);
}

/**
 * `in-app` for an http(s) Kortix link, `system` for any other http(s) link,
 * `null` for anything else (tel:, mailto:, an app scheme, malformed input) —
 * those are not web links and callers keep handling them themselves.
 */
export function linkTarget(url: string): LinkTarget | null {
  const host = httpHost(url);
  if (!host) return null;
  return isKortixHost(host) ? 'in-app' : 'system';
}
