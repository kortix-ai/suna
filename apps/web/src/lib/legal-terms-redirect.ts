/**
 * Permanent (308) redirect of the stable Terms-of-Service path to the Terms tab
 * of the legal page.
 *
 * `/legal` hosts the imprint, the Terms of Service and the privacy policy as
 * tabs (`?tab=terms`). Every link in the app points at the stable
 * `/legal/terms` (`legal-terms-links.test.ts`), so this maps it, and each
 * supported locale prefix (`/de/legal/terms`, …), onto `<prefix>/legal?tab=terms`
 * on the same origin. Other query params are carried over.
 *
 * The Terms used to live in a Google Drive file, and this redirect pointed
 * there. A browser that cached that earlier 308 keeps following it until its
 * cache drops the entry; nothing here can reach that cache.
 *
 * Emitted from `middleware.ts` BEFORE any auth/locale logic: the legal page
 * needs no session.
 */

import { locales } from '@/i18n/catalog.mjs';

type Locale = (typeof locales)[number];

/** `/legal/terms` plus each locale-prefixed variant, mapped to its `/legal`. */
const LEGAL_PATH_FOR_TERMS = new Map<string, string>([
  ['/legal/terms', '/legal'],
  ...locales.map((l): [string, string] => [`/${l}/legal/terms`, `/${l}/legal`]),
]);

/**
 * The Terms tab URL for a `/legal/terms` request, on `base`'s origin. Incoming
 * params are kept, except `tab`, which is always `terms`. Returns `null` for
 * every other path, so the caller falls through to normal rendering.
 */
export function legalTermsRedirectUrl(
  pathname: string,
  searchParams: URLSearchParams,
  base: string | URL,
): URL | null {
  const legalPath = LEGAL_PATH_FOR_TERMS.get(pathname);
  if (!legalPath) return null;

  const destination = new URL(legalPath, base);
  searchParams.forEach((value, key) => {
    if (key !== 'tab') destination.searchParams.set(key, value);
  });
  destination.searchParams.set('tab', 'terms');
  return destination;
}

/** Re-export so callers can keep locale logic close to the redirect logic. */
export type { Locale };
