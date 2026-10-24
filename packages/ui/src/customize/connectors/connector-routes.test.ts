import { describe, expect, test } from 'bun:test';

import type { CatalogEntry } from './catalog/catalog-entry';
import {
  appHref,
  appRefFromEntry,
  appRefFromLocation,
  connectorHref,
  connectorsHref,
  legacyDetailRedirect,
  connectorSearchFromParams,
  withConnectorSearch,
  browseForAnotherProfileHref,
  rulesHref,
  waysFromParams,
} from './connector-routes';

const BASE = '/projects/p1/customize/connectors';

const discoverEntry = {
  source: 'discover',
  key: 'discover:resend.com',
  slug: 'resend-com',
  name: 'Resend',
  description: null,
  icon: null,
  categories: [],
  popularity: null,
  connector: { id: 'resend.com' },
} as unknown as CatalogEntry;


describe('connectorsHref', () => {
  test('the bare list has no query', () => {
    expect(connectorsHref('p1')).toBe(BASE);
  });
  test('a scope rides as ?scope=', () => {
    expect(connectorsHref('p1', 'connected')).toBe(`${BASE}?scope=connected`);
    expect(rulesHref('p1')).toBe(`${BASE}?rules=1`);
  });
});

describe('app URLs', () => {
  test('a Discover app carries its id, because the detail fetch is by id', () => {
    const ref = appRefFromEntry(discoverEntry);
    expect(ref).toEqual({ source: 'discover', slug: 'resend-com', id: 'resend.com' });
    expect(appHref('p1', ref!)).toBe(`${BASE}/resend-com?id=resend.com`);
  });
  test('the location round-trips to the same ref', () => {
    expect(appRefFromLocation('resend-com', new URLSearchParams('id=resend.com'))).toEqual({
      source: 'discover',
      slug: 'resend-com',
      id: 'resend.com',
    });
    // The retired managed-catalogue link (`?src=apps`) names no app.
    expect(appRefFromLocation('google_sheets', new URLSearchParams('src=apps'))).toBeNull();
  });
  test('the reserved segment and an unmarked segment name no app', () => {
    expect(appRefFromLocation('connected', new URLSearchParams('id=x'))).toBeNull();
    expect(appRefFromLocation('resend-com', new URLSearchParams())).toBeNull();
    expect(appRefFromLocation('resend-com', null)).toBeNull();
  });
});

describe('connectorHref', () => {
  test('without an app it uses the reserved segment', () => {
    expect(connectorHref('p1', 'resend-abc123')).toBe(`${BASE}/connected/resend-abc123`);
  });
  test('with an app it nests under the app and keeps the app marker', () => {
    expect(
      connectorHref('p1', 'resend-abc123', {
        app: { source: 'discover', slug: 'resend-com', id: 'resend.com' },
      }),
    ).toBe(`${BASE}/resend-com/resend-abc123?id=resend.com`);
  });
  test('tab and the install hand-off ride as query params', () => {
    expect(
      connectorHref('p1', 'resend-abc123', {
        tab: 'tools',
        connect: { connectionId: 'c-1' },
      }),
    ).toBe(`${BASE}/connected/resend-abc123?tab=tools&connect=c-1`);
  });
  test('path segments are encoded', () => {
    expect(connectorHref('p 1', 'a/b')).toBe('/projects/p%201/customize/connectors/connected/a%2Fb');
  });
});

describe('legacyDetailRedirect', () => {
  test('?c= becomes the connector page', () => {
    expect(legacyDetailRedirect('p1', new URLSearchParams('scope=connected&c=resend-abc123'))).toBe(
      `${BASE}/connected/resend-abc123`,
    );
  });
  test('an OAuth return keeps its result', () => {
    expect(
      legacyDetailRedirect(
        'p1',
        new URLSearchParams('c=resend-abc123&oauth2=error&oauth2_error=denied'),
      ),
    ).toBe(`${BASE}/connected/resend-abc123?oauth2=error&oauth2_error=denied`);
  });
  test('no ?c= means no redirect', () => {
    expect(legacyDetailRedirect('p1', new URLSearchParams('scope=connected'))).toBeNull();
    expect(legacyDetailRedirect('p1', null)).toBeNull();
  });
});

// KRTX-3018: opening a connector unmounts the catalogue, and the search lived
// only in component state, so browser Back showed the full catalogue again.
describe('the catalogue search in the URL', () => {
  test('reads the trimmed query from ?q=', () => {
    expect(connectorSearchFromParams(new URLSearchParams('q=Shopify'))).toBe('Shopify');
    expect(connectorSearchFromParams(new URLSearchParams('scope=channels&q=%20slack%20'))).toBe('slack');
    expect(connectorSearchFromParams(new URLSearchParams('scope=channels'))).toBe('');
    expect(connectorSearchFromParams(null)).toBe('');
  });

  test('writes a non-empty query and drops an empty one, keeping the other params', () => {
    const params = new URLSearchParams('scope=channels');
    withConnectorSearch(params, ' Shopify ');
    expect(params.toString()).toBe('scope=channels&q=Shopify');
    withConnectorSearch(params, '   ');
    expect(params.toString()).toBe('scope=channels');
  });
});

describe('another profile', () => {
  const app = { source: 'discover' as const, slug: 'gmail', id: 'composio:gmail' };
  test('the app page keeps itself open with ways=1', () => {
    expect(appHref('p1', app, { ways: true })).toBe(`${BASE}/gmail?id=composio%3Agmail&ways=1`);
    expect(waysFromParams(new URLSearchParams('ways=1'))).toBe(true);
    expect(waysFromParams(new URLSearchParams(''))).toBe(false);
  });
  test('Browse searches for the app and links its cards to the app page', () => {
    expect(browseForAnotherProfileHref('p1', 'Gmail')).toBe(`${BASE}?scope=all&ways=1&q=Gmail`);
  });
});
