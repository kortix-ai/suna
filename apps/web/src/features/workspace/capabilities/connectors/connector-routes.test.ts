import { describe, expect, test } from 'bun:test';

import {
  catalogConnectorHref,
  connectedConnectorHref,
  parseCatalogSource,
} from './connector-routes';

describe('connector detail routes', () => {
  test('encodes connected connector path segments', () => {
    expect(connectedConnectorHref('project / 1', 'GitHub MCP')).toBe(
      '/projects/project%20%2F%201/connectors/GitHub%20MCP',
    );
  });

  for (const source of ['discover', 'easy-connect', 'computer'] as const) {
    test(`builds a ${source} catalogue route`, () => {
      expect(catalogConnectorHref('p1', { source, slug: 'GitHub Search' })).toBe(
        `/projects/p1/connectors/catalog/${source}/GitHub%20Search`,
      );
    });
  }

  test('accepts only supported catalogue sources', () => {
    expect(parseCatalogSource('discover')).toBe('discover');
    expect(parseCatalogSource('easy-connect')).toBe('easy-connect');
    expect(parseCatalogSource('computer')).toBe('computer');
    expect(parseCatalogSource('pipedream')).toBeNull();
    expect(parseCatalogSource('')).toBeNull();
  });
});
