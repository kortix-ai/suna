/**
 * The full per-action JSON Schema is the dominant contributor to the
 * connector listing payloads: `listConnectors` (`GET
 * /connectors/projects/:id/connectors`, measured 1.6MB body) and `listCatalog`
 * (`GET /connectors/projects/:id/catalog`, measured 439KB body). No
 * bulk-listing consumer reads `inputSchema` (dashboard, grant pickers,
 * `kortix connectors ls`, the MCP `"connectors"`/`"discover"` tools all
 * render name/status/action count only).
 *
 * Both routes now omit it by default (`inputSchema: null`) and require an
 * explicit `includeSchemas` opt-in — a contract-safe change since the field's
 * type (`Record<string, unknown> | null`) was already nullable.
 *
 * Real-Postgres tenant contract — mirrors
 * ./integration-connector-list-query-count.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectorActions, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER_A = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const CONNECTION = crypto.randomUUID();

const REAL_SCHEMA = { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] };

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'connector-schema-omission-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'connector-schema-omission-test',
    repoUrl: 'https://example.test/connector-schema-omission.git',
  });
  await db.insert(connectors).values({
    connectorId: CONNECTOR,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'mailer',
    name: 'Mailer',
    providerType: 'composio',
    config: { app: 'mailer' },
    enabled: true,
  });
  await db.insert(connectorConnections).values({
    connectionId: CONNECTION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId: CONNECTOR,
    ownerType: 'member',
    ownerId: USER_A,
    status: 'active',
    label: 'a@example.test',
    metadata: { provider: 'composio', toolkit: 'mailer', connected_account_id: 'ca_1' },
  });
  await db.insert(connectorActions).values({
    connectorId: CONNECTOR,
    path: 'send',
    name: 'Send',
    description: 'Send an email',
    risk: 'write',
    inputSchema: REAL_SCHEMA,
  });
});

afterAll(async () => {
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('listConnectors omits inputSchema unless includeSchemas is requested', () => {
  test('default: inputSchema is null', async () => {
    const list = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A);
    const mailer = list.find((c) => c.slug === 'mailer');
    expect(mailer?.actions).toHaveLength(1);
    expect(mailer?.actions[0]?.inputSchema).toBeNull();
    // The rest of the action stays intact — only the schema is trimmed.
    expect(mailer?.actions[0]?.path).toBe('send');
    expect(mailer?.actions[0]?.risk).toBe('write');
  });

  test('includeSchemas: true returns the real schema', async () => {
    const list = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A, { includeSchemas: true });
    const mailer = list.find((c) => c.slug === 'mailer');
    expect(mailer?.actions[0]?.inputSchema).toEqual(REAL_SCHEMA);
  });
});

describe('listCatalog omits inputSchema unless includeSchemas is requested, and slug filters to one connector', () => {
  const principal = {
    accountId: ACCOUNT,
    projectId: PROJECT,
    userId: USER_A,
    sessionId: null,
    subject: { userId: USER_A, groupIds: [] },
    agentPrincipal: null,
  };

  test('default: inputSchema is null', async () => {
    const list = await dbConnectorRouterDeps.listCatalog(principal);
    const mailer = list.find((c) => c.slug === 'mailer');
    expect(mailer?.actions[0]?.inputSchema).toBeNull();
  });

  test('includeSchemas: true returns the real schema', async () => {
    const list = await dbConnectorRouterDeps.listCatalog(principal, { includeSchemas: true });
    const mailer = list.find((c) => c.slug === 'mailer');
    expect(mailer?.actions[0]?.inputSchema).toEqual(REAL_SCHEMA);
  });

  test('slug restricts the result to one connector', async () => {
    const list = await dbConnectorRouterDeps.listCatalog(principal, { slug: 'mailer' });
    expect(list).toHaveLength(1);
    expect(list[0]?.slug).toBe('mailer');
  });

  test('an unknown slug returns an empty catalog, not everything', async () => {
    const list = await dbConnectorRouterDeps.listCatalog(principal, { slug: 'does-not-exist' });
    expect(list).toHaveLength(0);
  });
});
