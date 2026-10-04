/**
 * Pure helper for rewriting Supabase Storage URLs. Kept dependency-free (no
 * config/env import) so it is trivially unit-testable and safe to import from
 * anywhere. The config-bound wrapper lives in `./supabase` as
 * `toPublicStorageUrl`.
 *
 * Swap an `internal`-based URL prefix for `publicBase`. No-op when `publicBase`
 * is empty/unset or equal to `internal`, or when `url` does not start with
 * `internal` (already public).
 */
export function rewriteStorageOrigin(
  url: string,
  internal: string | undefined,
  publicBase: string | undefined,
): string {
  const i = internal?.replace(/\/+$/, '');
  const p = publicBase?.replace(/\/+$/, '');
  if (!i || !p || p === i) return url;
  return url.startsWith(i) ? p + url.slice(i.length) : url;
}
