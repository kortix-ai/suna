import { customizePath } from '../../lib/routes';
import type { CatalogEntry } from './catalog/catalog-entry';
import type { ConnectorScope } from './connector-filter';

/**
 * The app segment of a connector reached without an app: the Connected tab, a
 * custom connector, a computer. Its back link goes to the Connected tab.
 */
export const CONNECTED_APP_SEGMENT = 'connected';

/** The id of the native Computer entry: it has its own page (`ComputerAppPage`). */
export const COMPUTER_APP_ID = 'native:computer';

/**
 * Which catalogue app a page belongs to, as the URL carries it. The app is
 * fetched by `id` (`getDiscoverConnector`), so the id rides in the query.
 */
export type AppRef = { source: 'discover'; slug: string; id: string };

function base(projectId: string): string {
  return customizePath(encodeURIComponent(projectId), 'connectors');
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function appParams(app: AppRef): URLSearchParams {
  return new URLSearchParams({ id: app.id });
}

/** The Connectors page on one tab. Connectors, the landing tab, writes no param. */
export function connectorsHref(projectId: string, scope?: ConnectorScope): string {
  return scope && scope !== 'connectors' ? `${base(projectId)}?scope=${scope}` : base(projectId);
}

/**
 * The catalogue search, held in `?q=`. Opening a connector is a route change
 * that unmounts the catalogue; a search kept only in state was gone on browser
 * Back (KRTX-3018).
 */
const SEARCH_PARAM = 'q';

export function connectorSearchFromParams(search: Pick<URLSearchParams, 'get'> | null | undefined): string {
  return search?.get(SEARCH_PARAM)?.trim() ?? '';
}

/** Sets `?q=` to the trimmed query, or removes it when the query is empty. */
export function withConnectorSearch(params: URLSearchParams, query: string): URLSearchParams {
  const trimmed = query.trim();
  if (trimmed) params.set(SEARCH_PARAM, trimmed);
  else params.delete(SEARCH_PARAM);
  return params;
}

export function appRefFromEntry(entry: CatalogEntry): AppRef {
  return { source: 'discover', slug: entry.slug, id: entry.connector.id };
}

/**
 * An app's page. Once the project has the app it redirects to the connector
 * page; `ways` keeps it open, to install the app as another profile.
 */
export function appHref(projectId: string, app: AppRef, options: { ways?: boolean } = {}): string {
  const params = appParams(app);
  if (options.ways) params.set(WAYS_PARAM, '1');
  return withQuery(`${base(projectId)}/${encodeURIComponent(app.slug)}`, params);
}

const WAYS_PARAM = 'ways';

/** `?ways=1`: the app page stays open on an installed app, and Browse links there. */
export function waysFromParams(search: Pick<URLSearchParams, 'get'> | null | undefined): boolean {
  return search?.get(WAYS_PARAM) === '1';
}

/** Browse, searching for one app, with its cards opening the app page (`ways`). */
export function browseForAnotherProfileHref(projectId: string, name: string): string {
  const params = withConnectorSearch(new URLSearchParams({ scope: 'browse', [WAYS_PARAM]: '1' }), name);
  return withQuery(base(projectId), params);
}

export function appRefFromLocation(
  appSegment: string,
  search: URLSearchParams | null,
): AppRef | null {
  if (appSegment === CONNECTED_APP_SEGMENT) return null;
  const id = search?.get('id');
  return id ? { source: 'discover', slug: appSegment, id } : null;
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
