import { describe, expect, test } from 'bun:test';

import {
  catalogConnectorHref,
  catalogSourceFromSearch,
  connectedConnectorHref,
  parseCatalogSource,
} from './connector-routes';

describe('connector detail routes', () => {
  test('encodes connected connector path segments', () => {
    expect(connectedConnectorHref('project / 1', 'GitHub MCP')).toBe(
      '/projects/project%20%2F%201/connectors/GitHub%20MCP',
    );
  });

  // Catalogue apps live on the single-segment page — no `/catalog/<source>/`
  // spelling (Jay, 2026-09-13). Non-default catalogues ride as `?src=`.
  test('a discover app is the bare single-segment page', () => {
    expect(catalogConnectorHref('p1', { source: 'discover', slug: 'GitHub Search' })).toBe(
      '/projects/p1/connectors/GitHub%20Search',
    );
  });
  test('easy-connect and computer apps carry their catalogue marker', () => {
    expect(catalogConnectorHref('p1', { source: 'easy-connect', slug: 'canva' })).toBe(
      '/projects/p1/connectors/canva?src=apps',
    );
    expect(catalogConnectorHref('p1', { source: 'computer', slug: 'computers' })).toBe(
      '/projects/p1/connectors/computers?src=computer',
    );
  });
  test('the ?src marker round-trips back to the source', () => {
    expect(catalogSourceFromSearch('apps')).toBe('easy-connect');
    expect(catalogSourceFromSearch('computer')).toBe('computer');
    expect(catalogSourceFromSearch(null)).toBe('discover');
    expect(catalogSourceFromSearch('nonsense')).toBe('discover');
  });

  test('accepts only supported catalogue sources', () => {
    expect(parseCatalogSource('discover')).toBe('discover');
    expect(parseCatalogSource('easy-connect')).toBe('easy-connect');
    expect(parseCatalogSource('computer')).toBe('computer');
    expect(parseCatalogSource('pipedream')).toBeNull();
    expect(parseCatalogSource('')).toBeNull();
  });
});
