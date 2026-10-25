/**
 * The canonical spelling of a public page reached in another letter case
 * (`/Pricing`, `/DOCS`, `/DE/Pricing`) or with a trailing slash (`/pricing/`),
 * else `null`.
 *
 * Paths are case-sensitive, so other cases answered 200 with the "Page not
 * found" page (KRTX-3312). `skipTrailingSlashRedirect` (the /ingest proxy
 * needs it) left `/pricing/` a 200 duplicate of `/pricing` (KRTX-3234). Only
 * an exact public page qualifies, with an optional locale prefix: app paths
 * and deeper public paths can carry case-sensitive ids and names
 * (`/marketplace/<company>/…`).
 */
export function canonicalPublicPath(
  pathname: string,
  publicPaths: readonly string[],
  locales: readonly string[],
): string | null {
  const lower = pathname.toLowerCase();
  let end = lower.length;
  while (end > 1 && lower[end - 1] === '/') end -= 1;
  const canonical = lower.slice(0, end);
  if (canonical === pathname) return null;
  const [, first = ''] = canonical.split('/');
  const rest = locales.includes(first) ? canonical.slice(first.length + 1) || '/' : canonical;
  return publicPaths.includes(rest) ? canonical : null;
}
