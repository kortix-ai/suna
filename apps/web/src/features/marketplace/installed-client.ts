import type { InstalledItem, MarketplaceItem, RegistryItemStatus } from '@/lib/marketplace-client';

/** Display-facing status for an installed item, derived from the registry
 *  updates check. Absent from the updates map (or the check hasn't loaded
 *  yet) reads as `'up-to-date'` — the server only lists items that need
 *  attention (`update-available` / `orphaned`), so silence means "fine". */
export type InstalledItemStatus = RegistryItemStatus;

/** Resolves an installed item's status badge state from the (possibly still
 *  loading) `/registry/updates` map. Extracted so the up-to-date/update/
 *  orphaned decision is unit-testable without mounting the panel. */
export function deriveInstalledItemStatus(
  name: string,
  statusByName: Map<string, RegistryItemStatus>,
): InstalledItemStatus {
  return statusByName.get(name) ?? 'up-to-date';
}

/** Case-insensitive match over the fields a user would recognize an installed
 *  item by: its catalog title (when resolved), its raw registry name, its
 *  type label, and its source. Extracted so the search box's predicate is
 *  testable without react state. */
export function matchesInstalledItemQuery(
  item: InstalledItem,
  query: string,
  extra?: { catalogTitle?: string; typeLabel?: string },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [item.name, item.source, extra?.catalogTitle, extra?.typeLabel]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Filters an installed list against a search query, resolving each item's
 *  catalog title/type label via the supplied lookup so matches work on the
 *  friendly title, not just the raw registry name. */
export function filterInstalledItems(
  items: InstalledItem[],
  query: string,
  resolve: (item: InstalledItem) => { catalogTitle?: string; typeLabel?: string },
): InstalledItem[] {
  const q = query.trim();
  if (!q) return items;
  return items.filter((item) => matchesInstalledItemQuery(item, q, resolve(item)));
}

/** Precise consequence sentence for the remove confirm dialog — names the
 *  exact file count and that removal lands as a new commit, so the user
 *  knows what "Remove" actually does before confirming. */
export function describeRemoveConsequence(item: InstalledItem, catalogTitle?: string): string {
  const label = catalogTitle ?? item.name;
  const fileWord = item.file_count === 1 ? 'file' : 'files';
  return `This deletes ${item.file_count} ${fileWord} installed by "${label}" from the repo and commits the removal. This can't be undone from here.`;
}

/** Names of installed items eligible for a batch "Update all" — anything the
 *  updates check actually reports as `update-available`. Orphaned items are
 *  excluded (there's nothing to update them against). */
export function updatableInstalledItemNames(
  updates: { name: string; status: RegistryItemStatus }[],
): string[] {
  return updates.filter((u) => u.status === 'update-available').map((u) => u.name);
}

/** Builds the `Map<name, MarketplaceItem>` used to resolve an installed
 *  item's catalog title/description/capabilities, from a catalog page. */
export function buildCatalogByName(items: MarketplaceItem[]): Map<string, MarketplaceItem> {
  return new Map(items.map((item) => [item.name, item]));
}
