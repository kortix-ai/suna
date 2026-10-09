import type { CatalogEntry } from './catalog-entry';

const appKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * One search result list from both catalogues.
 *
 * Managed results keep their order. An app both list shows once, as its
 * API/MCP entry (MCP is the default way to connect) with the managed logo,
 * which is sharp where the catalogue's favicon is not. API/MCP-only apps
 * follow.
 */
export function mergeSearchEntries(
  managed: readonly CatalogEntry[],
  direct: readonly CatalogEntry[],
): CatalogEntry[] {
  const directByName = new Map<string, CatalogEntry>();
  for (const entry of direct) {
    const key = appKey(entry.name);
    if (!directByName.has(key)) directByName.set(key, entry);
  }
  const used = new Set<CatalogEntry>();
  const merged = managed.map((entry) => {
    const twin = directByName.get(appKey(entry.name));
    if (!twin || used.has(twin)) return entry;
    used.add(twin);
    return { ...twin, icon: entry.icon ?? twin.icon };
  });
  return merged.concat(direct.filter((entry) => !used.has(entry)));
}
