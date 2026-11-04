import type { FileTreeNode } from '@kortix/ui/file-tree';
import { buildFileTree } from '@kortix/ui/customize/shared/entity/entity-files';
import type { UiTranslator } from '@/i18n/translator';
import type { DependencyItem, ItemCapabilities, MarketplaceItem, MarketplaceItemDetail } from '@/lib/marketplace-client';
import { groupMarketplaceItemsByType } from './marketplace-grid';
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

/** A single "what's inside" row for a bundle's member items. Prefers the
 *  resolved `DependencyItem` (title/type known) and falls back to the bare
 *  dependency name when the server hasn't resolved it (e.g. an external ref
 *  the catalog couldn't join). */
export interface BundleMember {
  key: string;
  title: string;
  type: string | null;
  description: string | null;
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
        description: resolved.description,
        href: params.hrefForId(resolved.id),
      };
    }
    return { key: name, title: name, type: null, description: null, href: null };
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
export function groupCapabilities(
  caps: ItemCapabilities | undefined | null,
  tI18nComplete: UiTranslator,
): CapabilityGroup[] {
  if (!caps) return [];
  const groups: CapabilityGroup[] = [
    { kind: 'secret', label: tI18nComplete.raw('textd8707d411d99'), items: caps.secrets },
    { kind: 'connector', label: tI18nComplete.raw('textc3d2e79ebdd0'), items: caps.connectors },
    { kind: 'tool', label: tI18nComplete.raw('textea93d6a262ec'), items: caps.tools },
    { kind: 'network', label: tI18nComplete.raw('text1744b96470b5'), items: caps.network },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Total capability count across all groups — used for section-header counts
 *  and to decide whether the capabilities section renders at all. */
export function totalCapabilityCount(caps: ItemCapabilities | undefined | null): number {
  if (!caps) return 0;
  return caps.secrets.length + caps.connectors.length + caps.tools.length + caps.network.length;
}

/** The deepest directory every target shares (`@skills/pdf` for
 *  `@skills/pdf/SKILL.md` + `@skills/pdf/scripts/x.py`), or `''` when none. */
function commonDirectory(targets: readonly string[]): string {
  if (targets.length === 0) return '';
  const dirs = targets.map((t) => t.split('/').slice(0, -1));
  const first = dirs[0];
  let shared = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < shared && dir[i] === first[i]) i++;
    shared = i;
  }
  return first.slice(0, shared).join('/');
}

/**
 * An item's install targets as file-tree rows — the same ordering and
 * indentation as the capability entity modal (`buildFileTree`: SKILL.md first,
 * a directory's own files above its subdirectories), rooted at the directory
 * all targets share so the rows read as the skill's own files. When the
 * targets share no directory and some are nested, `buildFileTree` would drop
 * the nested ones, so they list flat by full path instead.
 */
export function marketplaceFileNodes(targets: readonly string[]): FileTreeNode[] {
  const dir = commonDirectory(targets);
  if (!dir && targets.some((t) => t.includes('/'))) {
    return [...targets].sort().map((path) => ({ path, name: path, depth: 0 }));
  }
  return buildFileTree(targets, dir);
}

export function projectContentGroups(data: MarketplaceItemDetail, tI18nComplete: UiTranslator) {
  if (data.type !== 'registry:project') return [];
  const toItem = (
    name: string,
    title: string,
    description: string | null,
    type: string,
    id: string,
  ): MarketplaceItem => ({
    id,
    registry: data.registry,
    name,
    type,
    title,
    description,
    categories: [],
    capabilities: { secrets: [], connectors: [], tools: [], network: [] },
    dependencies: [],
    fileCount: 0,
    external: data.external,
    marketplaceId: data.marketplaceId,
    marketplaceLabel: data.marketplaceLabel,
    owner: data.owner,
    sourceUrl: data.sourceUrl,
  });
  // A project shows its README first, then its contents rendered as the SAME
  // marketplace cards, in the SAME typed grid, as the main gallery — so a skill
  // inside the project looks exactly like a skill listed on the marketplace.
  // Each content item is a full catalog id, so we synthesize a MarketplaceItem
  // from the resolved dependency metadata + the project's own source identity.
  const byName = new Map(data.dependencyItems.map((d) => [d.name, d]));
  const items: MarketplaceItem[] = data.dependencies
    .map((name) => byName.get(name))
    .filter((d): d is MarketplaceItemDetail['dependencyItems'][number] => Boolean(d))
    .map((d) => toItem(d.name, d.title, d.description, d.type, d.id));
  const memberItemGroups = groupMarketplaceItemsByType(items);
  // A project's agents + triggers (parsed from kortix.yaml) rendered with the
  // SAME card + name-based icon heuristic as its skills — just non-navigable,
  // since they aren't their own catalog items.
  const groups: { label: string; items: MarketplaceItem[] }[] = [];
  if (data.projectAgents?.length) {
    groups.push({
      label: tI18nComplete.raw('text279b44d2ab4b'),
      items: data.projectAgents.map((a) =>
        toItem(a.name, a.title.replaceAll('-', ' '), a.description, 'registry:agent', `agent:${a.name}`),
      ),
    });
  }
  if (data.projectTriggers?.length) {
    groups.push({
      label: tI18nComplete.raw('texte62f2148a64d'),
      items: data.projectTriggers.map((t) =>
        toItem(t.slug, t.slug.replaceAll('-', ' '), t.description, 'registry:trigger', `trigger:${t.slug}`),
      ),
    });
  }

  return [
    ...memberItemGroups.map((g) => ({ ...g, navigable: true })),
    ...groups.map((g) => ({ ...g, navigable: false })),
  ];
}
