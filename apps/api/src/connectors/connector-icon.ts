/**
 * The icon a connector shows when its row stores none.
 *
 * Only a Pipedream sync writes `config.icon_url`. Every other connector listed
 * with `iconUrl: null`, so the Connected tab and the connector page drew a
 * generic glyph while the catalogue card for the same app showed its logo.
 * This resolves the same image the catalogue shows, at read time, so it also
 * covers connectors that already exist.
 *
 *   composio                     → the toolkit logo, by `config.app`.
 *   mcp / graphql / http / openapi / postman
 *                                → the catalogue icon of the domain that owns
 *                                  the host the connector calls, else of the
 *                                  app the connector is named after. Some apps
 *                                  serve MCP from a second domain the catalogue
 *                                  does not list, and Install names the
 *                                  connector after the app.
 *
 * A connector the catalogue cannot place gets no icon. The host is never sent
 * to an icon service, so a private hostname does not leave the deployment.
 */

export type FallbackIconSource =
  { kind: 'composio'; app: string } | { kind: 'catalog'; host: string | null };

export interface CatalogIcons {
  byDomain: ReadonlyMap<string, string>;
  byName: ReadonlyMap<string, string>;
}

/** Providers the catalogue covers → the config key that holds the URL they call. */
const HOST_KEY: Record<string, string | null> = {
  mcp: 'url',
  graphql: 'endpoint',
  http: 'baseUrl',
  openapi: 'server',
  postman: null,
};

export function fallbackIconSource(provider: string, config: unknown): FallbackIconSource | null {
  const cfg = (config ?? {}) as Record<string, unknown>;
  if (provider === 'composio') {
    return typeof cfg.app === 'string' && cfg.app ? { kind: 'composio', app: cfg.app } : null;
  }
  if (!(provider in HOST_KEY)) return null;
  const raw = cfg[HOST_KEY[provider] ?? ''];
  let host: string | null = null;
  try {
    if (typeof raw === 'string') host = new URL(raw).hostname || null;
  } catch {
    // Not a URL: the name can still place the connector.
  }
  return { kind: 'catalog', host };
}

/**
 * The icon of the app a connector is named after. Install names a connector
 * `<App>`, or `<App> <n>` for a second one, so a trailing number is dropped.
 */
export function iconForName(name: string, icons: ReadonlyMap<string, string>): string | null {
  const key = name.trim().toLowerCase();
  return icons.get(key) ?? icons.get(key.replace(/\s+\d+$/, '')) ?? null;
}

/** The icon of `host` or of the nearest parent domain the catalogue lists. */
export function iconForHost(host: string, icons: ReadonlyMap<string, string>): string | null {
  let candidate = host.toLowerCase();
  while (candidate.includes('.')) {
    const icon = icons.get(candidate);
    if (icon) return icon;
    candidate = candidate.slice(candidate.indexOf('.') + 1);
  }
  return null;
}

const FALLBACK_ICON_CAP_MS = 1500;

/**
 * Slug → icon for every row that stores no `icon_url`.
 *
 * Both sources are deployment-wide caches that a cold process fills with one
 * remote request. The connector list must not wait on a third party, so each
 * source is capped: past the cap the connector lists without an icon, and the
 * next read finds the cache warm. Never rejects.
 */
export async function resolveFallbackIcons(
  rows: ReadonlyArray<{
    slug: string;
    name: string;
    provider: string;
    config: unknown;
  }>,
  deps: {
    composioLogo: (app: string) => Promise<string | null>;
    catalogIcons: () => Promise<CatalogIcons>;
    capMs?: number;
  },
): Promise<Map<string, string>> {
  const capMs = deps.capMs ?? FALLBACK_ICON_CAP_MS;
  const capped = <T>(work: Promise<T>): Promise<T | null> =>
    Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), capMs).unref?.()),
    ]);

  const pending = rows.flatMap((row) => {
    const stored = (row.config as { icon_url?: unknown } | null)?.icon_url;
    if (typeof stored === 'string' && stored) return [];
    const source = fallbackIconSource(row.provider, row.config);
    return source ? [{ slug: row.slug, name: row.name, source }] : [];
  });
  if (pending.length === 0) return new Map();

  const needsCatalog = pending.some((item) => item.source.kind === 'catalog');
  const [catalog, logos] = await Promise.all([
    needsCatalog ? capped(Promise.resolve().then(deps.catalogIcons)) : null,
    // Every app asks Composio first: the managed catalogue grid shows its
    // logos, so a connector reads the same on its page as on the grid card.
    Promise.all(
      pending.map((item) =>
        capped(
          Promise.resolve(
            item.source.kind === 'composio' ? item.source.app : composioToolkitKey(item.name),
          ).then(deps.composioLogo),
        ),
      ),
    ),
  ]);

  const icons = new Map<string, string>();
  pending.forEach((item, index) => {
    const icon =
      item.source.kind === 'composio'
        ? logos[index]
        : (logos[index] ??
          (catalog
            ? ((item.source.host ? iconForHost(item.source.host, catalog.byDomain) : null) ??
              iconForName(item.name, catalog.byName))
            : null));
    if (icon) icons.set(item.slug, icon);
  });
  return icons;
}

/** A connector name as a Composio toolkit slug: `Figma 2` → `figma`. */
export function composioToolkitKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+\d+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
