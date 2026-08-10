import { describe, expect, test } from 'bun:test';

/**
 * The connector router declares several capabilities as OPTIONAL deps, so a
 * merge that drops one still typechecks and the route silently starts
 * answering 502 "catalogue unavailable" at runtime.
 *
 * That is exactly how Discover broke: #5000 wired listDiscoverConnectors,
 * getDiscoverConnector and discoverConnectorAuth into db-deps, and a later
 * merge built on a stale base removed them again with no build failure.
 *
 * Assert the wiring by reading the module source, so this test needs no
 * database or environment to run.
 */
const DB_DEPS_SOURCE = await Bun.file(
  new URL('../connectors/db-deps.ts', import.meta.url).pathname,
).text();

const REQUIRED_DEP_KEYS = [
  'listDiscoverConnectors',
  'getDiscoverConnector',
  'discoverConnectorAuth',
  'listPipedreamApps',
  'getWorkspacePolicies',
  'setWorkspacePolicies',
];

describe('dbConnectorRouterDeps wiring', () => {
  for (const key of REQUIRED_DEP_KEYS) {
    test(`wires ${key}`, () => {
      expect(DB_DEPS_SOURCE).toContain(`${key}:`);
    });
  }

  test('imports the integration catalogue that Discover reads from', () => {
    expect(DB_DEPS_SOURCE).toContain('./connector-catalog');
    expect(DB_DEPS_SOURCE).toContain('listConnectorCatalog');
    expect(DB_DEPS_SOURCE).toContain('getConnectorCatalogDetail');
  });
});
