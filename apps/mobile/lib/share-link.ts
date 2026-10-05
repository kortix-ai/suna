/**
 * Public share links (`kortix.com/share/*`).
 *
 * The app claims `/share/*` as a universal link (iOS `associatedDomains` +
 * the web AASA file, Android `intentFilters`), but has no in-app share
 * screen. A claimed link therefore opens the web share page in the in-app
 * browser instead of landing on the start screen.
 *
 * Pure: no React Native imports, so bun tests can run it directly.
 */
import { KORTIX_WEB_URL } from './kortix-web';

const SHARE_LINK_HOSTS = new Set(['kortix.com', 'www.kortix.com', 'staging.kortix.com']);

/** `scheme://authority/path?query#fragment`, each part kept verbatim. */
const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** `/share/<segment>` with a non-empty first segment. */
const SHARE_PATH = /^\/share\/[^/?#]+/;

/**
 * The https web URL to open for a share link, or `null` when `url` is not a
 * share link.
 * - `https://{kortix.com,www.kortix.com,staging.kortix.com}/share/…` is
 *   returned as-is (host, path, query and fragment preserved).
 * - `kortix://share/…` and `kortix:///share/…` map onto `KORTIX_WEB_URL`.
 */
export function resolveShareLinkUrl(url: string): string | null {
  const match = URL_PARTS.exec(url.trim());
  if (!match) return null;

  const scheme = match[1].toLowerCase();
  const authority = match[2].toLowerCase();
  const suffix = `${match[4] ?? ''}${match[5] ?? ''}`;
  let path = match[3];
  let origin: string;

  if (scheme === 'https') {
    if (!SHARE_LINK_HOSTS.has(authority)) return null;
    origin = `https://${authority}`;
  } else if (scheme === 'kortix') {
    if (authority === 'share') path = `/share${path}`;
    else if (authority !== '') return null;
    origin = KORTIX_WEB_URL;
  } else {
    return null;
  }

  if (!SHARE_PATH.test(path)) return null;
  return `${origin}${path}${suffix}`;
}
