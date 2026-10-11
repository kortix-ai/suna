/**
 * Where an external link opens — one rule for the whole app: every http(s)
 * link opens in the in-app browser (`WebBrowser.openBrowserAsync`: Safari View
 * Controller on iOS, a Chrome Custom Tab on Android), so the user never leaves
 * Kortix (KRTX-2104; it replaced COR-151's "third-party hosts go to the system
 * browser" split, which sent every App to Safari/Chrome).
 *
 * `openLink` (`./open-link.ts`) applies it. Pure: no React Native imports, so
 * bun tests run it directly. Parsed with a regex, not `URL`, because React
 * Native's built-in `URL` has no `hostname`.
 */

export type LinkTarget = 'in-app';

/** `scheme://authority…` — the authority is everything up to `/ ? #`. */
const HTTP_URL = /^(https?):\/\/([^/?#]*)/i;

/**
 * Options for every `WebBrowser.openBrowserAsync` call. `createTask: false`
 * keeps the Android Custom Tab inside the Kortix task: the default opens it as
 * its own Recents entry, which reads as leaving the app. iOS ignores it.
 */
export const IN_APP_BROWSER_OPTIONS = { createTask: false } as const;

/**
 * The lowercase host of an http(s) URL, without userinfo, port, or a trailing
 * dot; `null` for any other scheme or a malformed URL.
 */
export function httpHost(url: string): string | null {
  const match = HTTP_URL.exec(url.trim());
  if (!match) return null;
  // `user:pass@host:port` → `host`. The LAST `@` ends the userinfo.
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  const host = authority.replace(/:\d*$/, '').replace(/\.$/, '').toLowerCase();
  return host || null;
}

/**
 * `in-app` for any http(s) link, `null` for anything else (tel:, mailto:, an
 * app scheme, malformed input) — those are not web links and go to the OS.
 */
export function linkTarget(url: string): LinkTarget | null {
  return httpHost(url) ? 'in-app' : null;
}
