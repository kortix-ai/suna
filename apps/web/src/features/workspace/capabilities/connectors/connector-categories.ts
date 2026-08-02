/**
 * Two rows of the widest grid (`xl:grid-cols-3`). The live catalogue makes
 * this load-bearing rather than theoretical: one page of
 * `listDiscoverIntegrations` puts 26 of its 48 items under `productivity`
 * alone, so a category section renders its first 6 and defers the rest to
 * "View all".
 */
export const CATEGORY_ROW_CAP = 6;

const OTHER = 'Other';

/**
 * Bucket catalog items under every category they claim. Items are duplicated
 * across their categories on purpose — that is how a browse surface works, and
 * `DiscoverIntegration.categories` is genuinely multi-valued.
 *
 * Categories are trimmed and blank ones are dropped before anything else.
 * `categories: ['']` is not hypothetical — `Malwarebytes` ships exactly that
 * in the live catalogue, and a plain `cats.length > 0` check would accept the
 * empty string as a category and render a section under a blank heading.
 * Trimming also stops `' data'` and `'data '` from forking one category into
 * two adjacent sections. An item left with nothing after that is genuinely
 * uncategorized and lands in `Other`.
 *
 * The bucket key is the RAW (trimmed) catalogue value — `sales-and-marketing`,
 * not `Sales and marketing`. It is what the category filter round-trips and
 * what the API would be queried with; `humanizeCategory` is applied at render
 * only. Keeping the display string out of the key means a change to the
 * wording cannot silently repartition the groups.
 */
export function groupByCategory<T>(
  items: readonly T[],
  getCategories: (item: T) => readonly string[],
): Array<{ category: string; items: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const named = getCategories(item)
      .map((category) => category.trim())
      .filter((category) => category.length > 0);
    // `new Set` so an item that lists the same category twice is not rendered
    // twice inside one section (which would also duplicate its React key).
    const keys = named.length > 0 ? new Set(named) : new Set([OTHER]);
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
  }
  return [...buckets.entries()]
    .map(([category, bucketItems]) => ({ category, items: bucketItems }))
    .sort((a, b) => {
      if (a.category === OTHER) return 1;
      if (b.category === OTHER) return -1;
      if (a.items.length !== b.items.length) return b.items.length - a.items.length;
      return a.category.localeCompare(b.category);
    });
}

/**
 * A catalogue category as a section heading. The values arrive kebab-case
 * (`sales-and-marketing`, `financial-services`), which reads as broken markup
 * when rendered raw. Hyphen -> space matches the existing transform at
 * `lib/utils/kortix-system-tags.ts:131`.
 *
 * Only the first character is capitalized; the tail is left exactly as the
 * catalogue published it. Lowercasing the tail would produce sentence case for
 * kebab values but turn any acronym (`CRM`) into `Crm`, and this catalogue is
 * third-party data whose casing we do not control.
 */
export function humanizeCategory(raw: string): string {
  const spaced = raw.trim().replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
