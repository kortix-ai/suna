import { describe, expect, test } from 'bun:test';

import type { CatalogEntry } from './catalog/catalog-entry';
import {
  appHref,
  appRefFromEntry,
  appRefFromLocation,
  connectorHref,
  connectorsHref,
  legacyDetailRedirect,
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

const managedEntry = {
  source: 'easy-connect',
  key: 'easy-connect:google_sheets',
  slug: 'google_sheets',
  name: 'Google Sheets',
  description: null,
  icon: null,
  categories: [],
  popularity: null,
  app: { slug: 'google_sheets', name: 'Google Sheets' },
} as unknown as CatalogEntry;

describe('connectorsHref', () => {
  test('the bare list has no query', () => {
    expect(connectorsHref('p1')).toBe(BASE);
  });
  test('a scope rides as ?scope=', () => {
    expect(connectorsHref('p1', 'connected')).toBe(`${BASE}?scope=connected`);
  });
});

describe('app URLs', () => {
  test('a Discover app carries its id, because the detail fetch is by id', () => {
    const ref = appRefFromEntry(discoverEntry);
    expect(ref).toEqual({ source: 'discover', slug: 'resend-com', id: 'resend.com' });
    expect(appHref('p1', ref!)).toBe(`${BASE}/resend-com?id=resend.com`);
  });
  test('a managed app carries ?src=apps', () => {
    const ref = appRefFromEntry(managedEntry);
    expect(appHref('p1', ref!)).toBe(`${BASE}/google_sheets?src=apps`);
  });
  test('the computer entry has no app page', () => {
    expect(appRefFromEntry({ source: 'computer' } as unknown as CatalogEntry)).toBeNull();
  });
  test('the location round-trips to the same ref', () => {
    expect(appRefFromLocation('resend-com', new URLSearchParams('id=resend.com'))).toEqual({
      source: 'discover',
      slug: 'resend-com',
      id: 'resend.com',
    });
    expect(appRefFromLocation('google_sheets', new URLSearchParams('src=apps'))).toEqual({
      source: 'easy-connect',
      slug: 'google_sheets',
    });
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
