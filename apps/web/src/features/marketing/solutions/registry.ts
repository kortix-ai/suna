import { dataScience } from './roles/data-science';
import { engineering } from './roles/engineering';
import { finance } from './roles/finance';
import { it } from './roles/it';
import { marketing } from './roles/marketing';
import { people } from './roles/people';
import { product } from './roles/product';
import { sales } from './roles/sales';
import type { RoleContent } from './types';

/**
 * The Solutions role axis, in nav order.
 *
 * Eight roles, in two columns of four in the nav menu. The order is the order
 * they read in: the four revenue- and product-facing teams first, the four
 * operational ones second. It is not alphabetical, and it is not a ranking.
 *
 * WHY EIGHT AND NOT FEWER: each page is written from that role's own work and
 * carries its own specimen artifact — a patch for engineering, a reconciliation
 * for finance, a query for data science, a document for the writing roles. Any
 * pair that could be merged without losing something would have been merged; a
 * thin page is worse than no page.
 *
 * NAMING: these labels are shared with the home-page use-case cards. Keep the
 * spelling identical across both surfaces — "Data Science", not "Data";
 * "People", not "HR" or "Recruiting".
 */
export const ROLES: readonly RoleContent[] = [
  sales,
  marketing,
  product,
  engineering,
  finance,
  people,
  it,
  dataScience,
];

/**
 * The nav menu is NOT derived from this registry, on purpose: `site-config.ts`
 * is imported by the client navbar, so importing this module there would ship
 * every word of all eight role pages in the client bundle. The menu carries its
 * own short labels. Keep the `name` values here identical to the ones there.
 */
export function getRole(slug: string): RoleContent | undefined {
  return ROLES.find((role) => role.slug === slug);
}

/** Every `/solutions/<slug>` path, for `generateStaticParams` and the SEO records. */
export const ROLE_PATHS = ROLES.map((role) => `/solutions/${role.slug}`);
