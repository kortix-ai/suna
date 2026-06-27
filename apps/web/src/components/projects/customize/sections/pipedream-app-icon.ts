/**
 * Resolving a connected connector's real app logo from the Pipedream catalogue.
 *
 * Pipedream's app search (`q`) filters by app NAME ("Google Sheets"), not by slug
 * ("google_sheets"). A connected connector only carries the stable app slug, so
 * searching the catalogue with the raw slug never matches a multi-word app and the
 * UI silently falls back to a generic glyph. We instead search by the de-slugified
 * words and then pick the exact slug match out of the page — the same logo the
 * "Add app" / Easy Connect grid shows.
 */
export function appSearchQueryFromSlug(slug: string): string {
  return slug.replace(/_/g, ' ').trim();
}

/** Pick a connector's logo URL from a catalogue search page by exact slug match. */
export function pickAppIconBySlug(
  apps: ReadonlyArray<{ slug: string; imgSrc: string | null }> | undefined,
  slug: string,
): string | null {
  return apps?.find((a) => a.slug === slug)?.imgSrc ?? null;
}
