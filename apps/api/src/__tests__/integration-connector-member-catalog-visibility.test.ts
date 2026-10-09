/**
 * A tool catalog fetched with one member's personal account
 * (`config.catalog_source: 'member'`, written by `syncProjectConnectors`) is
 * listed only to people with an account on that connector. Another project
 * member sees the connector, but not its tool names.
 *
 * Real-Postgres contract: runs in the db-suites lane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  connectionCredentials,
  connectorActions,
  connectorConnections,
  connectors,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PERSONAL = crypto.randomUUID();
const SHARED = crypto.randomUUID();
const OWNER_CONNECTION = crypto.randomUUID();
// The unsigned "Everyone in project" account an older connector carries:
// every member reaches it, and it must NOT unlock a personal catalog.
const EMPTY_SHARED = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const OTHER = crypto.randomUUID();

const mcp = (connectorId: string, slug: string, config: Record<string, unknown>) => ({
  connectorId,
  accountId: ACCOUNT,
  projectId: PROJECT,
  slug,
  name: slug,
  providerType: 'mcp' as const,
  config: { url: `https://${slug}.example.test/mcp`, ...config },
});

const action = (connectorId: string, path: string) => ({
  connectorId,
  path,
  name: path,
  description: 'synthetic tool',
});

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'member-catalog-visibility' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'member-catalog-visibility',
    repoUrl: 'https://example.test/member-catalog-visibility.git',
  });
  await db
    .insert(connectors)
    .values([mcp(PERSONAL, 'personal', { catalog_source: 'member' }), mcp(SHARED, 'shared', {})]);
  await db.insert(connectorConnections).values([
    {
      connectionId: OWNER_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: PERSONAL,
      ownerType: 'member',
      ownerId: OWNER,
      status: 'active',
      label: 'Personal',
    },
    {
      connectionId: EMPTY_SHARED,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: PERSONAL,
      ownerType: 'project',
      ownerId: null,
      status: 'active',
      label: 'personal',
    },
  ]);
  await db.insert(connectionCredentials).values({
    connectorId: PERSONAL,
    connectionId: OWNER_CONNECTION,
    valueEnc: encryptProjectSecret(PROJECT, 'synthetic-token'),
  });
  await db
    .insert(connectorActions)
    .values([action(PERSONAL, 'personal.list_boards'), action(SHARED, 'shared.search')]);
});

afterAll(async () => {
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const actionsFor = async (userId: string, slug: string) =>
  (await dbConnectorRouterDeps.listConnectors(PROJECT, userId))
    .find((connector) => connector.slug === slug)
    ?.actions.map((a) => a.path);

describe('a member-published tool catalog', () => {
  test('its owner sees the tools', async () => {
    expect(await actionsFor(OWNER, 'personal')).toEqual(['personal.list_boards']);
  });

  test('another member sees the connector without its tool names, even with the empty shared account', async () => {
    expect(await actionsFor(OTHER, 'personal')).toEqual([]);
  });

  test('a catalog not published by a member is listed as before', async () => {
    expect(await actionsFor(OTHER, 'shared')).toEqual(['shared.search']);
  });
});
