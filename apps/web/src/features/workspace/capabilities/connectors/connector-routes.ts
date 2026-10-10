import type { CatalogEntry } from './catalog/catalog-entry';

/**
 * The app segment of a connector reached without an app: the Connected tab, a
 * custom connector, a computer. Its back link goes to the Connected tab.
 */
export const CONNECTED_APP_SEGMENT = 'connected';

/**
 * Which catalogue app a page belongs to, as the URL carries it. A Discover app
 * is fetched by `id` (`getDiscoverConnector`), so the id rides in the query;
 * a managed app is looked up by slug.
 */
export type AppRef =
  { source: 'discover'; slug: string; id: string } | { source: 'easy-connect'; slug: string };

function base(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/customize/connectors`;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function appParams(app: AppRef): URLSearchParams {
  const params = new URLSearchParams();
  if (app.source === 'discover') params.set('id', app.id);
  else params.set('src', 'apps');
  return params;
}

export function connectorsHref(
  projectId: string,
  scope?: 'all' | 'connected' | 'channels',
): string {
  return scope ? `${base(projectId)}?scope=${scope}` : base(projectId);
}

/** `null` for the computer entry: a computer has no app page. */
export function appRefFromEntry(entry: CatalogEntry): AppRef | null {
  if (entry.source === 'discover') {
    return { source: 'discover', slug: entry.slug, id: entry.connector.id };
  }
  if (entry.source === 'easy-connect') return { source: 'easy-connect', slug: entry.slug };
  return null;
}

export function appHref(projectId: string, app: AppRef): string {
  return withQuery(`${base(projectId)}/${encodeURIComponent(app.slug)}`, appParams(app));
}

export function appRefFromLocation(
  appSegment: string,
  search: URLSearchParams | null,
): AppRef | null {
  if (appSegment === CONNECTED_APP_SEGMENT) return null;
  const id = search?.get('id');
  if (id) return { source: 'discover', slug: appSegment, id };
  if (search?.get('src') === 'apps') return { source: 'easy-connect', slug: appSegment };
  return null;
}

export function connectorHref(
  projectId: string,
  connectorSlug: string,
  options: {
    app?: AppRef | null;
    tab?: string;
    /** The install hand-off: open credential entry for this account once. */
    connect?: { connectionId: string };
    /** Open "Add account" once, right after Install added the profile. */
    addAccount?: boolean;
  } = {},
): string {
  const segment = options.app ? options.app.slug : CONNECTED_APP_SEGMENT;
  const params = options.app ? appParams(options.app) : new URLSearchParams();
  if (options.tab) params.set('tab', options.tab);
  if (options.connect) params.set('connect', options.connect.connectionId);
  if (options.addAccount) params.set('add', '1');
  return withQuery(
    `${base(projectId)}/${encodeURIComponent(segment)}/${encodeURIComponent(connectorSlug)}`,
    params,
  );
}

/**
 * The list page used to hold the open connector in `?c=<slug>`, and an OAuth
 * grant started there returns to that URL. Forward it to the connector page
 * with the result intact.
 */
export function legacyDetailRedirect(
  projectId: string,
  search: URLSearchParams | null,
): string | null {
  const slug = search?.get('c');
  if (!slug) return null;
  const params = new URLSearchParams();
  for (const key of ['oauth2', 'oauth2_error']) {
    const value = search?.get(key);
    if (value) params.set(key, value);
  }
  return withQuery(connectorHref(projectId, slug), params);
}
