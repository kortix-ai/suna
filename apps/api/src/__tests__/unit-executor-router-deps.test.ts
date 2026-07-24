import { describe, expect, test } from 'bun:test';

/**
 * The executor router declares several capabilities as OPTIONAL deps, so a
 * merge that drops one still typechecks and the route silently starts
 * answering 502 "catalogue unavailable" at runtime.
 *
 * That is exactly how Discover broke: #5000 wired listDiscoverIntegrations,
 * getDiscoverIntegration and discoverConnectorAuth into db-deps, and a later
 * merge built on a stale base removed them again with no build failure.
 *
 * Assert the wiring by reading the module source, so this test needs no
 * database or environment to run.
 */
const DB_DEPS_SOURCE = await Bun.file(
  new URL('../executor/db-deps.ts', import.meta.url).pathname,
).text();

const REQUIRED_DEP_KEYS = [
  'listDiscoverIntegrations',
  'getDiscoverIntegration',
  'discoverConnectorAuth',
  'listPipedreamApps',
  'getProjectPolicies',
  'setProjectPolicies',
];

describe('dbExecutorRouterDeps wiring', () => {
  for (const key of REQUIRED_DEP_KEYS) {
    test(`wires ${key}`, () => {
      expect(DB_DEPS_SOURCE).toContain(`${key}:`);
    });
  }

  test('imports the integration catalogue that Discover reads from', () => {
    expect(DB_DEPS_SOURCE).toContain('./integration-catalog');
    expect(DB_DEPS_SOURCE).toContain('listIntegrationCatalog');
    expect(DB_DEPS_SOURCE).toContain('getIntegrationCatalogDetail');
  });
});
