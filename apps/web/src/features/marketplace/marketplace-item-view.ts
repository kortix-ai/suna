import type { DependencyItem, ItemCapabilities, MarketplaceItem } from '@/lib/marketplace-client';
import { typeMeta } from './marketplace-meta';

/** Type-aware copy for the "no description" state. Every item type reads as
 *  itself instead of silently assuming "skill". */
export function emptyDescriptionCopy(type: string): string {
  return `This ${typeMeta(type).label.toLowerCase()} doesn't have a description yet.`;
}

/** Type-aware copy for the "no README" empty state. */
export function emptyReadmeCopy(type: string): string {
  return `This ${typeMeta(type).label.toLowerCase()} doesn't ship a README yet.`;
}

/** Type-aware meta-line count label for a card/detail (e.g. "3 items" for a
 *  bundle's member count, "12 files" for everything else). */
export function itemCountLabel(item: Pick<MarketplaceItem, 'type' | 'dependencies' | 'fileCount'>): {
  count: number;
  unit: string;
} {
  if (item.type === 'registry:bundle') {
    const count = item.dependencies.length;
    return { count, unit: count === 1 ? 'item' : 'items' };
  }
  const count = item.fileCount;
  return { count, unit: count === 1 ? 'file' : 'files' };
}

/** A single "what's inside" row for a bundle's member items. Prefers the
 *  resolved `DependencyItem` (title/type known) and falls back to the bare
 *  dependency name when the server hasn't resolved it (e.g. an external ref
 *  the catalog couldn't join). */
export interface BundleMember {
  key: string;
  title: string;
  type: string | null;
  href: string | null;
}

/** Derives the ordered member list for a bundle's "What's inside" section,
 *  joining `dependencies` (names, always present) against `dependencyItems`
 *  (resolved metadata, best-effort) by name. Extracted so the join/fallback
 *  logic is unit-testable without mounting the detail view. */
export function resolveBundleMembers(params: {
  dependencies: string[];
  dependencyItems: DependencyItem[];
  hrefForId: (id: string) => string;
}): BundleMember[] {
  const byName = new Map(params.dependencyItems.map((d) => [d.name, d]));
  return params.dependencies.map((name) => {
    const resolved = byName.get(name);
    if (resolved) {
      return {
        key: resolved.id,
        title: resolved.title,
        type: resolved.type,
        href: params.hrefForId(resolved.id),
      };
    }
    return { key: name, title: name, type: null, href: null };
  });
}

/** One row in the grouped capability-badge display. */
export type CapabilityKind = 'secret' | 'connector' | 'tool' | 'network';

export interface CapabilityGroup {
  kind: CapabilityKind;
  label: string;
  items: string[];
}

/** Groups an item's `capabilities` into labeled sections for the detail
 *  view's scannable badge rows, dropping empty groups. Includes `network`,
 *  which existing detail views silently omitted. */
export function groupCapabilities(caps: ItemCapabilities | undefined | null): CapabilityGroup[] {
  if (!caps) return [];
  const groups: CapabilityGroup[] = [
    { kind: 'secret', label: 'Secrets', items: caps.secrets },
    { kind: 'connector', label: 'Connectors', items: caps.connectors },
    { kind: 'tool', label: 'Tools', items: caps.tools },
    { kind: 'network', label: 'Network', items: caps.network },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Total capability count across all groups — used for section-header counts
 *  and to decide whether the capabilities section renders at all. */
export function totalCapabilityCount(caps: ItemCapabilities | undefined | null): number {
  if (!caps) return 0;
  return caps.secrets.length + caps.connectors.length + caps.tools.length + caps.network.length;
}
