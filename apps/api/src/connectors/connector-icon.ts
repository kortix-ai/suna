/**
 * The logo an existing connector shows — resolved from the SAME sources the
 * connectors catalogue uses, so a connected app looks exactly like its
 * Discover card.
 *
 * Sync stores `icon_url` only for Pipedream apps. Every other connector reached
 * the list with `iconUrl: null` and rendered a generic provider glyph, while the
 * Discover tab showed the real logo for the same app (KRTX-203). This module
 * fills that gap at read time:
 *
 * - `composio` — the toolkit logo, from `composioToolkitLogo` (the 6-hour
 *   toolkit cache the Composio catalogue page is enriched from).
 * - `openapi` / `http` / `graphql` / `mcp` — the icon of the Discover card whose
 *   domain matches the host the connector calls (`iconsByDomain`, the
 *   integrations.sh index the Discover tab lists).
 * - everything else — nothing; the client keeps its provider glyph.
 *
 * Only hosts that are already in the public catalogue resolve, so a private
 * API's hostname never leaves the server.
 */
import { composioToolkitLogo } from './composio';
import { connectorCatalogIconsByDomain } from './connector-catalog';

/** Time the connector list waits for a cold icon source before it answers
 *  without logos. The source keeps loading; the next list is served from its
 *  warm cache. */
const DEFAULT_BUDGET_MS = 1_500;

const DIRECT_PROVIDER_URL_KEY: Record<string, string> = {
  mcp: 'url',
  http: 'baseUrl',
  graphql: 'endpoint',
  openapi: 'server',
};

export interface ConnectorIconSubject {
  slug: string;
  provider: string;
  config: Record<string, unknown> | null;
}

export interface ConnectorIconSources {
  composioLogo: (toolkit: string) => Promise<string | null>;
  catalogIcons: () => Promise<ReadonlyMap<string, string>>;
}

const DEFAULT_SOURCES: ConnectorIconSources = {
  composioLogo: composioToolkitLogo,
  catalogIcons: connectorCatalogIconsByDomain,
};

/**
 * The host a direct-provider connector sends its calls to, lower-cased.
 *
 * Deliberately NOT the OpenAPI/Postman spec URL: specs are usually hosted on a
 * code host (`raw.githubusercontent.com`, `github.com`), and matching that
 * would give every such connector the code host's logo.
 */
export function connectorEndpointHost(
  provider: string,
  config: Record<string, unknown> | null,
): string | null {
  const key = DIRECT_PROVIDER_URL_KEY[provider];
  const raw = key ? config?.[key] : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return new URL(raw.trim()).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The catalogue icon for a host: an exact domain match, else the parent domain
 * with exactly one leading label removed (`api.stripe.com` -> `stripe.com`,
 * `mcp.linear.app` -> `linear.app`).
 *
 * One label, not a walk to the root: shared platforms are catalogue entries too
 * (`amazonaws.com`, `googleapis.com`), and a customer API on
 * `x.execute-api.<region>.amazonaws.com` must not wear the AWS logo. A parent
 * needs at least two labels, so a bare TLD never matches.
 */
export function catalogIconForHost(
  host: string,
  icons: ReadonlyMap<string, string>,
): string | null {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.every((label) => /^\d+$/.test(label))) return null;
  const exact = icons.get(labels.join('.'));
  if (exact) return exact;
  if (labels.length < 3) return null;
  return icons.get(labels.slice(1).join('.')) ?? null;
}

function withinBudget<T>(promise: Promise<T>, fallback: T, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), budgetMs);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Logos for connectors that have none stored, keyed by slug. A connector with
 * no resolvable logo is absent from the map.
 *
 * Never throws and never waits longer than `budgetMs` on a source: a missing
 * logo is a glyph tile, not an error, and it must not slow the connector list.
 */
export async function resolveConnectorIcons(
  subjects: readonly ConnectorIconSubject[],
  sources: ConnectorIconSources = DEFAULT_SOURCES,
  { budgetMs = DEFAULT_BUDGET_MS }: { budgetMs?: number } = {},
): Promise<Map<string, string>> {
  const toolkits = new Map<string, string>();
  const hosts = new Map<string, string>();
  for (const subject of subjects) {
    if (subject.provider === 'composio') {
      const app = subject.config?.app;
      if (typeof app === 'string' && app.trim()) toolkits.set(subject.slug, app.trim());
      continue;
    }
    const host = connectorEndpointHost(subject.provider, subject.config);
    if (host) hosts.set(subject.slug, host);
  }

  const [toolkitLogos, catalogIcons] = await Promise.all([
    withinBudget(
      Promise.all(
        [...new Set(toolkits.values())].map(
          async (toolkit) =>
            [toolkit, await sources.composioLogo(toolkit).catch(() => null)] as const,
        ),
      ),
      [] as Array<readonly [string, string | null]>,
      budgetMs,
    ),
    hosts.size > 0
      ? withinBudget(sources.catalogIcons(), new Map<string, string>(), budgetMs)
      : Promise.resolve(new Map<string, string>()),
  ]);

  const logoByToolkit = new Map(toolkitLogos);
  const resolved = new Map<string, string>();
  for (const [slug, toolkit] of toolkits) {
    const logo = logoByToolkit.get(toolkit);
    if (logo) resolved.set(slug, logo);
  }
  for (const [slug, host] of hosts) {
    const icon = catalogIconForHost(host, catalogIcons);
    if (icon) resolved.set(slug, icon);
  }
  return resolved;
}
