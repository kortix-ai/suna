import type { CatalogEntry } from './catalog/catalog-entry';

const CATALOG_SOURCES = ['discover', 'easy-connect', 'computer'] as const;

export function connectedConnectorHref(projectId: string, slug: string): string {
  return `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(slug)}`;
}

export function catalogConnectorHref(
  projectId: string,
  entry: Pick<CatalogEntry, 'source' | 'slug'>,
): string {
  return `/projects/${encodeURIComponent(projectId)}/connectors/catalog/${entry.source}/${encodeURIComponent(entry.slug)}`;
}

export function parseCatalogSource(value: string): CatalogEntry['source'] | null {
  return CATALOG_SOURCES.find((source) => source === value) ?? null;
}
