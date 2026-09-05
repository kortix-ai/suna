import type {
  MarketplaceTemplateConnector,
  MarketplaceTemplate as SdkMarketplaceTemplate,
} from '@kortix/sdk';

/**
 * The template view model — a thin adapter over the SDK's `MarketplaceTemplate`.
 *
 * It holds no data: the store reads `useMarketplaceTemplates()`, and everything
 * below is derivation the components need and the API does not send.
 *
 * It is deliberately SERVER-SAFE — no icon values, no React. The tile lives in
 * `./template-visual.ts`, which is client-graph only because Phosphor's main
 * entry calls `createContext` at module scope. That split is what lets a server
 * component read a template.
 */

/** The wire shape, re-exported so components import one name. */
export type MarketplaceTemplate = SdkMarketplaceTemplate;

/**
 * One app a template needs, as the install modal lists it.
 *
 * Two keys, deliberately, because they answer different questions:
 *
 *  - `id` is the Composio toolkit slug (`gmail`, `linear`). It keys the LOGO,
 *    and a template may name a toolkit we ship no mark for.
 *  - `slug` is the manifest's connector name. It is what a project's own
 *    connector will be called after the install, so it — not `id` — is the key
 *    that decides whether the project already has this connector.
 */
export interface TemplateConnectorRow {
  /** Toolkit slug for the logo mark. Falls back to `slug`. */
  id: string;
  /** The manifest connector name — the key a project connector matches on. */
  slug: string;
  /** Display name. */
  label: string;
}

/** `owner/repo`. */
export const templateRepoSlug = (template: MarketplaceTemplate): string => template.repo;

/** Link-out target for the provenance row. */
export const templateRepoUrl = (template: MarketplaceTemplate): string =>
  `https://github.com/${template.repo_owner}/${template.repo_name}`;

/**
 * Map the API's connector requirements onto rows.
 *
 * A `kortix.yaml` declares no per-connector "role", so the row shows the app's
 * own name and leaves the trailing edge for the project's connection state —
 * which is a fact, unlike a made-up role.
 */
export function templateConnectorRows(template: MarketplaceTemplate): TemplateConnectorRow[] {
  return (template.connectors ?? []).map((connector: MarketplaceTemplateConnector) => {
    const slug = (connector.slug ?? '').toLowerCase();
    const id = (connector.app ?? slug).toLowerCase();
    return { id, slug, label: connector.slug || id };
  });
}

/** Client-side search over the fields a person would type. */
export function templateMatchesQuery(template: MarketplaceTemplate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    template.title.toLowerCase().includes(q) ||
    (template.description ?? '').toLowerCase().includes(q) ||
    template.repo.toLowerCase().includes(q) ||
    template.slug.toLowerCase().includes(q)
  );
}

/** `3 templates` / `1 template`. Takes the SINGULAR and adds the `s`. */
export function countLabel(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
