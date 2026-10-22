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
// db-deps.ts wires ConnectorRouterDeps; db-deps-gateway.ts wires GatewayDeps.
const DB_DEPS_SOURCE = (
  await Promise.all(
    ['db-deps.ts', 'db-deps-gateway.ts'].map((file) =>
      Bun.file(new URL(`../connectors/${file}`, import.meta.url).pathname).text(),
    ),
  )
).join('\n');

const REQUIRED_DEP_KEYS = [
  'listDiscoverConnectors',
  'listDiscoverSections',
  'getDiscoverConnector',
  'discoverConnectorAuth',
  'listPipedreamApps',
  'getProjectPolicies',
  'setProjectPolicies',
  // Optional on GatewayDeps; without it Slack/Teams reads reach every
  // conversation of the shared workspace token (channel-read-scope.ts).
  'gateChannelRead',
  // Same for writes (channel-write-scope.ts): posts, edits, deletes, reactions.
  'gateChannelWrite',
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
