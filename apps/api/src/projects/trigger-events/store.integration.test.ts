import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  accounts,
  connectorConnections,
  connectors,
  createDb,
  type Database,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as store from './store';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009811';
const PROJECT_ID = '00000000-0000-4000-a000-000000009812';
const CONNECTOR_ID = '00000000-0000-4000-a000-000000009813';
const CONNECTION_ID = '00000000-0000-4000-a000-000000009814';

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 4 });
  return integrationDb;
}

async function cleanup() {
  const db = testDb();
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

const row = (slug: string, overrides: Partial<store.EventSubscriptionInput> = {}) => ({
  projectId: PROJECT_ID,
  slug,
  accountId: ACCOUNT_ID,
  provider: 'composio',
  connectionId: CONNECTION_ID,
  eventType: 'EXAMPLE_EVENT',
  externalId: 'ti_shared',
  desiredHash: 'h1',
  status: 'active' as const,
  ...overrides,
});

describeWithDb('trigger event subscription store — real PostgreSQL', () => {
  beforeEach(async () => {
    await cleanup();
    const db = testDb();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Event store proof' });
    await db.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'Event store proof',
      repoUrl: 'https://example.test/event-store.git',
    });
    await db.insert(connectors).values({
      connectorId: CONNECTOR_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: 'example-app',
      name: 'Example app',
      providerType: 'composio',
    });
    await db.insert(connectorConnections).values({
      connectionId: CONNECTION_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      connectorId: CONNECTOR_ID,
      label: 'Example account',
      metadata: { connected_account_id: 'ca_example' },
    });
  });
  afterEach(cleanup);

  test('upsert, get, list, status, touch and delete round trip', async () => {
    await store.upsert(row('a'));
    expect((await store.get(PROJECT_ID, 'a'))?.externalId).toBe('ti_shared');
    await store.upsert(row('a', { desiredHash: 'h2', externalId: 'ti_new' }));
    const updated = await store.get(PROJECT_ID, 'a');
    expect(updated?.desiredHash).toBe('h2');
    expect(updated?.externalId).toBe('ti_new');
    expect(await store.listByProject(PROJECT_ID)).toHaveLength(1);

    await store.markStatus(PROJECT_ID, 'a', 'needs_connection', 'Connect it.');
    expect((await store.get(PROJECT_ID, 'a'))?.status).toBe('needs_connection');
    expect((await store.get(PROJECT_ID, 'a'))?.lastError).toBe('Connect it.');

    await store.touchLastEvent(PROJECT_ID, 'a');
    expect((await store.get(PROJECT_ID, 'a'))?.lastEventAt).toBeInstanceOf(Date);

    await store.deleteRow(PROJECT_ID, 'a');
    expect(await store.get(PROJECT_ID, 'a')).toBeNull();
  });

  test('a status outside the CHECK list is rejected', async () => {
    await expect(store.upsert(row('bad', { status: 'nope' as never }))).rejects.toThrow();
  });

  test('two rows share one external id: rows and count see both', async () => {
    await store.upsert(row('a'));
    await store.upsert(row('b'));
    await store.upsert(row('c', { externalId: 'ti_other' }));
    expect(await store.countByExternalId('composio', 'ti_shared')).toBe(2);
    expect((await store.rowsByExternalId('composio', 'ti_shared')).map((r) => r.slug).sort()).toEqual([
      'a',
      'b',
    ]);
    expect(await store.countByExternalId('composio', 'ti_missing')).toBe(0);

    await store.markErrorByExternalId('composio', 'ti_shared', 'Subscription disabled.');
    expect((await store.get(PROJECT_ID, 'a'))?.status).toBe('error');
    expect((await store.get(PROJECT_ID, 'c'))?.status).toBe('active');
  });

  test('markErrorByConnectedAccount hits only rows on that connected account', async () => {
    await store.upsert(row('a'));
    await store.upsert(row('b', { connectionId: null, externalId: null }));
    await store.markErrorByConnectedAccount('composio', 'ca_other', 'x');
    expect((await store.get(PROJECT_ID, 'a'))?.status).toBe('active');
    await store.markErrorByConnectedAccount('composio', 'ca_example', 'Reconnect the app.');
    expect((await store.get(PROJECT_ID, 'a'))?.lastError).toBe('Reconnect the app.');
    expect((await store.get(PROJECT_ID, 'b'))?.status).toBe('active');
  });

  test('deleting the connection nulls connection_id; deleting the project cascades', async () => {
    await store.upsert(row('a'));
    await testDb()
      .delete(connectorConnections)
      .where(eq(connectorConnections.connectionId, CONNECTION_ID));
    expect((await store.get(PROJECT_ID, 'a'))?.connectionId).toBeNull();
    await testDb().delete(projects).where(eq(projects.projectId, PROJECT_ID));
    expect(await store.listByProject(PROJECT_ID)).toHaveLength(0);
  });

  test('withProjectEventLock serializes one project and skips the loser', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = store.withProjectEventLock(PROJECT_ID, async () => {
      entered();
      await held;
    });
    await inside;
    let ran = false;
    const second = await store.withProjectEventLock(PROJECT_ID, async () => {
      ran = true;
    });
    expect(second).toBe(false);
    expect(ran).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await store.withProjectEventLock(PROJECT_ID, async () => {})).toBe(true);
  });
});
