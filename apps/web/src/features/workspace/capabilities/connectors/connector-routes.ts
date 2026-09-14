import type { CatalogEntry } from './catalog/catalog-entry';

const CATALOG_SOURCES = ['discover', 'easy-connect', 'computer'] as const;

export function connectedConnectorHref(projectId: string, slug: string): string {
  return `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(slug)}`;
}

/**
 * A project connector viewed IN ITS APP'S CONTEXT — the split view: the app's
 * catalogue page on the left, this connector's own UI in the right column.
 * `/connectors/<app>` alone is the app page; the single-segment
 * `connectedConnectorHref` still resolves (the [slug] route forwards here
 * when the connector's app is identifiable).
 */
export function appConnectorHref(
  projectId: string,
  appSlug: string,
  connectorSlug: string,
): string {
  return `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(appSlug)}/${encodeURIComponent(connectorSlug)}`;
}

/**
 * A catalogue app's page is `/connectors/<slug>` — the same single segment the
 * resolver disambiguates (Jay: no `/catalog/<source>/` spelling). Discover is
 * the default catalogue; the other sources ride as `?src=` so the resolver's
 * fallback reads the right one. The old `/connectors/catalog/...` route still
 * exists only to forward here.
 */
export function catalogConnectorHref(
  projectId: string,
  entry: Pick<CatalogEntry, 'source' | 'slug'>,
): string {
  const base = `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(entry.slug)}`;
  if (entry.source === 'easy-connect') return `${base}?src=apps`;
  if (entry.source === 'computer') return `${base}?src=computer`;
  return base;
}

/** The `?src=` marker ↔ catalogue source. Absent/unknown = Discover. */
export function catalogSourceFromSearch(src: string | null): CatalogEntry['source'] {
  if (src === 'apps') return 'easy-connect';
  if (src === 'computer') return 'computer';
  return 'discover';
}

export function parseCatalogSource(value: string): CatalogEntry['source'] | null {
  return CATALOG_SOURCES.find((source) => source === value) ?? null;
}
