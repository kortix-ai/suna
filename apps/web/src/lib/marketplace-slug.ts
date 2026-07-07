// Marketplace catalog ids are `${company}:${name}` (e.g. `kortix:code-review`).
// Company ids may contain slashes (`anthropics/skills`), so the public routes
// encode them as a single path segment (`anthropics--skills`). Item names may
// also contain slashes and use a catch-all segment after the company.

const COMPANY_SEP = '--';

/** Encode a marketplace / company id into one URL path segment. */
export function companySlugFromId(marketplaceId: string): string {
  return marketplaceId
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join(COMPANY_SEP);
}

/** Decode a company path segment back to a marketplace id. */
export function companyIdFromSlug(slug: string): string {
  return slug.split(COMPANY_SEP).map((part) => decodeURIComponent(part)).join('/');
}

export interface ItemPathParts {
  company: string;
  item: string[];
}

/** Split a catalog id into company slug + item path segments. */
export function itemIdToPathParts(id: string): ItemPathParts {
  const colon = id.indexOf(':');
  if (colon === -1) {
    return { company: companySlugFromId(id), item: [] };
  }
  const marketplaceId = id.slice(0, colon);
  const name = id.slice(colon + 1);
  return {
    company: companySlugFromId(marketplaceId),
    item: name ? name.split('/').map((segment) => encodeURIComponent(segment)) : [],
  };
}

/** Rebuild a catalog id from a company slug + item path segments. */
export function pathPartsToItemId(companySlug: string, itemSegments: string[]): string {
  const company = companyIdFromSlug(companySlug);
  const name = itemSegments.map((segment) => decodeURIComponent(segment)).join('/');
  return name ? `${company}:${name}` : company;
}

/** Canonical public href for a marketplace item. */
export function marketplaceItemHref(id: string): string {
  const { company, item } = itemIdToPathParts(id);
  const segments = [company, ...item].join('/');
  return `/marketplace/${segments}`;
}

/** Canonical public href for browsing a single company / source. */
export function marketplaceCompanyHref(marketplaceId: string): string {
  return `/marketplace/${companySlugFromId(marketplaceId)}`;
}
