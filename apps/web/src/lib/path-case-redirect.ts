/**
 * The lowercase spelling of a public page reached in another letter case
 * (`/Pricing`, `/DOCS`, `/DE/Pricing`), else `null`.
 *
 * Paths are case-sensitive, so those answered 200 with the "Page not found"
 * page (KRTX-3312). Only an exact public page qualifies, with an optional
 * locale prefix: app paths and deeper public paths can carry case-sensitive
 * ids and names (`/marketplace/<company>/…`).
 */
export function lowercasePublicPath(
  pathname: string,
  publicPaths: readonly string[],
  locales: readonly string[],
): string | null {
  const lower = pathname.toLowerCase();
  if (lower === pathname) return null;
  const [, first = ''] = lower.split('/');
  const rest = locales.includes(first) ? lower.slice(first.length + 1) || '/' : lower;
  return publicPaths.includes(rest) ? lower : null;
}
