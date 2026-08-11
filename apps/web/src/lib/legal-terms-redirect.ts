/**
 * Permanent (308) redirect of every Terms-of-Service URL to the canonical
 * public Google Drive file that now owns the Terms document.
 *
 * The legal page (`/legal`) used to host three tabs — imprint, terms, and
 * privacy. Terms moved out to an externally-owned Drive file; the legal page
 * now only renders imprint and privacy. Both the new stable path
 * (`/legal/terms`) and the legacy tab query (`/legal?tab=terms`), including
 * every supported locale prefix (`/de/legal/terms`, `/de/legal?tab=terms`, …),
 * must permanently redirect to that file so existing links and bookmarks
 * keep resolving.
 *
 * The redirect is a 308 (Permanent Redirect) which preserves the request method
 * and is cacheable. It is emitted from `middleware.ts` BEFORE any auth/locale
 * logic, because the destination is an external URL that needs no session.
 */

import { locales, type Locale } from '@/i18n/config';

/**
 * Canonical public Google Drive file that owns the Terms of Service
 * (dosco Terms of Service - Version 2026-07-14.pdf).
 * The `usp=sharing` param is what lets Drive render the file publicly
 * without forcing a sign-in — it must always be present on the destination
 * and must never be overwritten by an incoming `usp` value.
 */
export const LEGAL_TERMS_DRIVE_BASE =
  'https://drive.google.com/file/d/1KJ4lLxz6LQosk0DZIosSAf01GK8PdQ54/view';

/**
 * Query params that are dropped when building the redirect destination:
 * - `tab` — the legacy legal-page selector; once we redirect, it is meaningless
 *   on the Drive URL and would only confuse the destination.
 * - `usp` — Drive's own sharing flag. An incoming `usp` (e.g. `usp=sharing` or
 *   anything else) must never override the value we set on the destination.
 */
const STRIPPED_PARAMS = new Set(['tab', 'usp']);

/** `/legal` itself plus each locale-prefixed variant (`/de/legal`, …). */
const LEGAL_PATHS = new Set<string>(['/legal', ...locales.map((l) => `/${l}/legal`)]);

/** `/legal/terms` plus each locale-prefixed variant. */
const LEGAL_TERMS_PATHS = new Set<string>([
  '/legal/terms',
  ...locales.map((l) => `/${l}/legal/terms`),
]);

function isLegalTermsPath(pathname: string): boolean {
  return LEGAL_TERMS_PATHS.has(pathname);
}

function isLegalPath(pathname: string): boolean {
  return LEGAL_PATHS.has(pathname);
}

/**
 * Build the permanent Drive-file destination URL for a Terms request.
 *
 * Rules:
 * 1. The base is the canonical Drive file.
 * 2. `usp=sharing` is always set and never overridden by an incoming `usp`.
 * 3. `tab` is always dropped.
 * 4. Every other incoming query param is preserved (sorted for a stable,
 *    cache-friendly URL).
 *
 * Returns `null` when the request is NOT a Terms request (neither the stable
 * `/legal/terms` path nor the legacy `/legal?tab=terms` query, in any locale),
 * so the caller can fall through to normal rendering.
 */
export function legalTermsRedirectUrl(
  pathname: string,
  searchParams: URLSearchParams,
): URL | null {
  const isTermsPath = isLegalTermsPath(pathname);
  const isLegacyTerms =
    isLegalPath(pathname) && searchParams.get('tab') === 'terms';

  if (!isTermsPath && !isLegacyTerms) return null;

  const destination = new URL(LEGAL_TERMS_DRIVE_BASE);

  // Preserve unrelated params, drop `tab` and `usp`, then force `usp=sharing`.
  // Build the destination params in sorted key order so the URL is stable and
  // cache-friendly regardless of the order the inbound params arrived in.
  const carried: Array<[string, string]> = [];
  searchParams.forEach((value, key) => {
    if (STRIPPED_PARAMS.has(key)) return;
    carried.push([key, value]);
  });
  carried.push(['usp', 'sharing']);
  carried.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of carried) {
    destination.searchParams.set(key, value);
  }

  return destination;
}

/** Re-export so callers can keep locale logic close to the redirect logic. */
export type { Locale };
