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

/** The short paths a visitor types for the legal texts, and where each lives.
 *  They answered 200 with the "Page not found" page (KRTX-3256). */
const LEGAL_SHORT_PATHS: Record<string, { path: string; tab?: 'terms' | 'privacy' | 'imprint' }> = {
  '/terms': { path: '/legal', tab: 'terms' },
  '/privacy': { path: '/legal', tab: 'privacy' },
  '/imprint': { path: '/legal', tab: 'imprint' },
  '/subprocessors': { path: '/legal/subprocessors' },
};

/**
 * The legal page for a short path (`/privacy`, `/de/privacy`, …) on `base`'s
 * origin, with incoming params kept and `tab` set where the text is a tab.
 * Returns `null` for every other path.
 */
export function legalShortPathRedirectUrl(
  pathname: string,
  searchParams: URLSearchParams,
  base: string | URL,
): URL | null {
  const [, first, second, ...rest] = pathname.split('/');
  const prefixed = (locales as readonly string[]).includes(first ?? '');
  if (rest.length > 0 || (!prefixed && second !== undefined)) return null;
  const target = LEGAL_SHORT_PATHS[`/${prefixed ? second : first}`];
  if (!target) return null;

  const destination = new URL(prefixed ? `/${first}${target.path}` : target.path, base);
  searchParams.forEach((value, key) => {
    if (key !== 'tab') destination.searchParams.set(key, value);
  });
  if (target.tab) destination.searchParams.set('tab', target.tab);
  return destination;
}

/** Re-export so callers can keep locale logic close to the redirect logic. */
export type { Locale };
