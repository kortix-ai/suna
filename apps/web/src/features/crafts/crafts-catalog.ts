import type { Craft as SdkCraft, CraftConnectorSummary } from '@kortix/sdk';

/**
 * The craft view model — a thin adapter over the SDK's `Craft`.
 *
 * This module used to hold a hardcoded nine-entry array for the UI phase. It
 * now holds no data at all: the store reads `useCrafts()`, and everything below
 * is derivation the components need and the API does not send.
 *
 * It is deliberately SERVER-SAFE — no icon values, no React. The tile lives in
 * `./craft-visual.ts`, which is client-graph only because Phosphor's main entry
 * calls `createContext` at module scope. That split is what lets a server
 * component read a craft.
 */

/** The wire shape, re-exported so components import one name. */
export type Craft = SdkCraft;

/**
 * One app a craft needs, as the install modal lists it.
 *
 * Two keys, deliberately, because they answer different questions:
 *
 *  - `id` is the Composio toolkit slug (`gmail`, `linear`). It keys the LOGO,
 *    and a craft may name a toolkit we ship no mark for.
 *  - `slug` is the manifest's connector name. It is what a project's own
 *    connector will be called after the install, so it — not `id` — is the key
 *    that decides whether the project already has this connector.
 *
 * Merging them would break one case or the other: a craft that requires `gmail`
 * under the alias `inbox` has a Gmail logo and a connector named `inbox`.
 */
export interface CraftConnectorRow {
  /** Toolkit slug for the logo mark. Falls back to `slug`. */
  id: string;
  /** The manifest connector name — the key a project connector matches on. */
  slug: string;
  /** Display name. */
  label: string;
}

/**
 * `owner/repo` for a github craft, or the archive name for an upload.
 *
 * The API already computes this — an upload has NULL repo columns, and joining
 * them client-side would render "null/null". Reading `craft.repo` keeps one
 * answer on both sides.
 */
export const craftRepoSlug = (craft: Craft): string => craft.repo;

/**
 * Link-out target for the modal's provenance row, or null when there is
 * nowhere to go. An uploaded craft has no repository — the row must state that
 * rather than link to a 404.
 */
export function craftRepoUrl(craft: Craft): string | null {
  if (craft.source_kind !== 'github' || !craft.repo_owner || !craft.repo_name) return null;
  return `https://github.com/${craft.repo_owner}/${craft.repo_name}`;
}

/** True when this craft came from an uploaded archive rather than a repo. */
export const craftIsUpload = (craft: Craft): boolean => craft.source_kind === 'upload';

/** Compact count for card meta — `2431` renders `2.4k`, `986` stays `986`. */
export const formatCount = (n: number): string =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/**
 * Map the API's connector requirements onto rows.
 *
 * The mock carried a `role` per connector ("reads issues", "opens the upgrade
 * PR"). A `kortix.yaml` declares no such field, so rather than invent one the
 * row shows the app's own name and leaves the trailing edge for the project's
 * connection state — which is a fact, unlike a made-up role.
 */
export function craftConnectorRows(craft: Craft): CraftConnectorRow[] {
  return (craft.connectors ?? []).map((connector: CraftConnectorSummary) => {
    const slug = (connector.slug ?? '').toLowerCase();
    const id = (connector.app ?? slug).toLowerCase();
    return { id, slug, label: connector.slug || id };
  });
}

/** Client-side search over the fields a person would type. */
export function craftMatchesQuery(craft: Craft, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    craft.title.toLowerCase().includes(q) ||
    (craft.description ?? '').toLowerCase().includes(q) ||
    craft.repo.toLowerCase().includes(q) ||
    craft.slug.toLowerCase().includes(q)
  );
}
