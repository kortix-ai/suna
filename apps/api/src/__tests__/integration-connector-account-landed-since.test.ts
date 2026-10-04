/**
 * `connectorAccountLandedSince` (connectors/credentials.ts): the read behind a
 * connect link's `connected` flag (`GET /v1/setup-links/connectors/:token`).
 * A chat card that is reloaded stays "Connected" only if an account landed on
 * the link's connector after the link was minted.
 *
 * Real-Postgres contract — run with DATABASE_URL pointed at an isolated
 * migrated database (mirrors integration-connector-list-member-credential-status.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectionCredentials, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { connectorAccountLandedSince } from '../connectors/credentials';
import { encryptProjectSecret } from '../projects/secrets';
import { db } from '../lib/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();

// Every timestamp is written explicitly, so the test never races the clock.
const BEFORE = new Date('2026-08-01T10:00:00.000Z');
const MINTED = new Date('2026-08-01T12:00:00.000Z');
const AFTER = new Date('2026-08-01T13:00:00.000Z');

/** One connector per case, so no row of one case answers for another. */
async function connector(slug: string, providerType: 'pipedream' | 'composio') {
  const connectorId = crypto.randomUUID();
  await db.insert(connectors).values({
    connectorId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug,
    name: slug,
    providerType,
    config: { app: slug },
  });
  return connectorId;
}

async function connection(
  connectorId: string,
  row: {
    ownerType: 'project' | 'member' | 'agent';
    ownerId?: string;
    updatedAt: Date;
    metadata?: Record<string, unknown>;
    credentialAt?: Date;
  },
) {
  const connectionId = crypto.randomUUID();
  await db.insert(connectorConnections).values({
    connectionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId,
    ownerType: row.ownerType,
    ownerId: row.ownerId ?? null,
    status: 'active',
    label: `${row.ownerType}-${connectionId.slice(0, 8)}`,
    metadata: row.metadata ?? {},
    updatedAt: row.updatedAt,
  });
  if (row.credentialAt) {
    await db.insert(connectionCredentials).values({
      connectorId,
      connectionId,
      valueEnc: encryptProjectSecret(PROJECT, 'capability'),
      updatedAt: row.credentialAt,
    });
  }
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'account-landed-since-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'account-landed-since-test',
    repoUrl: 'https://example.test/account-landed-since.git',
  });
});

afterAll(async () => {
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a credential row (Pipedream, API key, OAuth2)', () => {
  test('an account that already existed when the link was minted does not settle it', async () => {
    const id = await connector('already_there', 'pipedream');
    await connection(id, { ownerType: 'project', updatedAt: BEFORE, credentialAt: BEFORE });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(false);
  });

  test('a shared account that landed after the mint settles it for every member', async () => {
    const id = await connector('shared_after', 'pipedream');
    await connection(id, { ownerType: 'project', updatedAt: AFTER, credentialAt: AFTER });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(true);
    expect(await connectorAccountLandedSince(id, null, MINTED)).toBe(true);
  });

  test("a member's own account settles it for that member only", async () => {
    const id = await connector('private_after', 'pipedream');
    await connection(id, { ownerType: 'member', ownerId: USER_A, updatedAt: AFTER, credentialAt: AFTER });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(true);
    expect(await connectorAccountLandedSince(id, USER_B, MINTED)).toBe(false);
    expect(await connectorAccountLandedSince(id, null, MINTED)).toBe(false);
  });

  test('an agent-owned binding never settles a link', async () => {
    const id = await connector('agent_binding', 'pipedream');
    await connection(id, { ownerType: 'agent', ownerId: 'agent-1', updatedAt: AFTER, credentialAt: AFTER });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(false);
  });
});

describe('a Composio account, recorded on the connection row', () => {
  const authorized = { provider: 'composio', connected_account_id: 'ca_1', is_no_auth: false };

  test('an account authorized after the mint settles it, with no credential row at all', async () => {
    const id = await connector('composio_after', 'composio');
    await connection(id, { ownerType: 'member', ownerId: USER_A, updatedAt: AFTER, metadata: authorized });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(true);
    expect(await connectorAccountLandedSince(id, USER_B, MINTED)).toBe(false);
  });

  test('an account authorized before the mint does not', async () => {
    const id = await connector('composio_before', 'composio');
    await connection(id, { ownerType: 'member', ownerId: USER_A, updatedAt: BEFORE, metadata: authorized });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(false);
  });

  test('an authorization that was started and never finished does not', async () => {
    // Connect stamps the row and leaves `connected_account_id` null until finalize.
    const id = await connector('composio_open', 'composio');
    await connection(id, {
      ownerType: 'member',
      ownerId: USER_A,
      updatedAt: AFTER,
      metadata: { provider: 'composio', connected_account_id: null, is_no_auth: false },
    });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(false);
  });

  test('a toolkit that needs no authorization settles once it is asked for', async () => {
    const id = await connector('composio_no_auth', 'composio');
    await connection(id, {
      ownerType: 'project',
      updatedAt: AFTER,
      metadata: { provider: 'composio', connected_account_id: null, is_no_auth: true },
    });
    expect(await connectorAccountLandedSince(id, USER_A, MINTED)).toBe(true);
  });
});
