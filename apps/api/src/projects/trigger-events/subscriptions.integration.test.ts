import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accountGroups,
  accounts,
  connectorConnections,
  connectors,
  createDb,
  type Database,
  projectTriggerRuntime,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { clearAuthorizeCaches } from '../../iam/authorize';
import type { GitTriggerSpec } from '../trigger-types';

const fires: Array<Record<string, any>> = [];
let fireStatus: 'fired' | 'failed' | 'deduped' = 'fired';
const actualTriggers = await import('../lib/triggers');
mock.module('../lib/triggers', () => ({
  ...actualTriggers,
  fireGitTrigger: async (input: Record<string, any>) => {
    fires.push(input);
    if (fireStatus === 'failed') return { status: 'failed', error: 'boom' };
    return { status: 'fired', sessionId: 'sess_synthetic', deduped: fireStatus === 'deduped' };
  },
}));

// The connect route's finalize, stubbed: it lands the provider account id like the real one does.
const finalizeCalls: unknown[][] = [];
mock.module('../../connectors/db-deps', () => ({
  dbConnectorRouterDeps: {
    connectorFinalize: async (...args: unknown[]) => {
      finalizeCalls.push(args);
      const selector = args[3] as { connectionId: string };
      await testDb()
        .update(connectorConnections)
        .set({ metadata: { connected_account_id: 'ca_activated' } })
        .where(eq(connectorConnections.connectionId, selector.connectionId));
      return { provider: 'composio', connected: true };
    },
  },
}));

const { reconcileEventSubscriptions, reconcileEventSubscriptionsFromCatalog } = await import('./subscriptions');
const { applyNotices, deliverEvents } = await import('./deliver');
const { setEventSourceForTest } = await import('./registry');
const { listEventApps, validateEventTrigger } = await import('./catalog');
const store = await import('./store');

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009821';
const PROJECT_ID = '00000000-0000-4000-a000-000000009822';
const CONNECTOR_ID = '00000000-0000-4000-a000-000000009823';
const CONNECTION_ID = '00000000-0000-4000-a000-000000009824';
const SECOND_CONNECTION_ID = '00000000-0000-4000-a000-000000009826';

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 4 });
  return integrationDb;
}

// Fake provider: `subscribe` mints one id per (type, config), like Composio's idempotent upsert.
const calls: string[] = [];
let subscribeError: Error | null = null;
const fake = {
  id: 'composio',
  configured: () => true,
  ingressConfigured: () => true,
  listEventTypes: async () => [],
  listApps: async () => [],
  subscribe: async ({ type, config }: { type: string; config: Record<string, unknown> }) => {
    calls.push(`subscribe:${type}`);
    if (subscribeError) throw subscribeError;
    return { externalId: `ti_${type}_${JSON.stringify(config)}` };
  },
  unsubscribe: async (id: string) => {
    calls.push(`unsubscribe:${id}`);
  },
  receive: async () => ({ deliveries: [], notices: [] }),
};

const spec = (slug: string, over: Partial<GitTriggerSpec> = {}, config: Record<string, unknown> = {}): GitTriggerSpec => ({
  slug,
  path: `kortix.yaml#triggers.${slug}`,
  name: slug,
  type: 'event',
  agent: 'default',
  model: null,
  enabled: true,
  promptTemplate: 'Mail {{ event.data.subject }} on {{ event.app }}',
  cron: null,
  runAt: null,
  timezone: 'UTC',
  secretEnv: null,
  run: null,
  monitorMode: null,
  intervalSeconds: null,
  expectEventWithinSeconds: null,
  event: { connector: 'inbox', type: 'EXAMPLE_NEW_MESSAGE', config },
  sessionMode: 'fresh',
  pinnedSessionId: null,
  sessionKey: null,
  filter: null,
  ...over,
});

async function cleanup() {
  await testDb().delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await testDb().delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}
const connect = (over: Partial<typeof connectorConnections.$inferInsert> = {}) =>
  testDb().insert(connectorConnections).values({
    connectionId: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    connectorId: CONNECTOR_ID,
    label: 'Shared account',
    metadata: { connected_account_id: 'ca_example' },
    ...over,
  });
const catalog = async (s: GitTriggerSpec) =>
  testDb().insert(projectTriggerRuntime).values({
    projectId: PROJECT_ID,
    slug: s.slug,
    triggerType: s.type,
    enabled: s.enabled,
    scheduleSpec: s as unknown as Record<string, unknown>,
  });
const status = async (slug: string) => (await store.get(PROJECT_ID, slug))?.status;

describeWithDb('event subscriptions — real PostgreSQL, fake provider', () => {
  beforeEach(async () => {
    await cleanup();
    calls.length = 0;
    fires.length = 0;
    fireStatus = 'fired';
    subscribeError = null;
    setEventSourceForTest('composio', fake);
    const db = testDb();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Event reconcile proof' });
    await db.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'Event reconcile proof',
      repoUrl: 'https://example.test/event-reconcile.git',
    });
    await db.insert(connectors).values({
      connectorId: CONNECTOR_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: 'inbox',
      name: 'Inbox',
      providerType: 'composio',
      config: { app: 'example' },
    });
  });
  afterEach(async () => {
    setEventSourceForTest('composio', undefined);
    await cleanup();
  });

  test('needs_connection until a shared account exists, then active; a repeat call is a no-op', async () => {
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(await status('a')).toBe('needs_connection');
    expect((await store.get(PROJECT_ID, 'a'))?.lastError).toContain('Connect a shared Inbox account');
    expect(calls).toEqual([]);

    await connect();
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    const row = await store.get(PROJECT_ID, 'a');
    expect(row?.status).toBe('active');
    expect(row?.externalId).toBe('ti_EXAMPLE_NEW_MESSAGE_{}');
    expect(row?.connectionId).toBe(CONNECTION_ID);

    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(calls).toEqual(['subscribe:EXAMPLE_NEW_MESSAGE']);
  });

  test('a connector named after its slug is named by its app in the status text', async () => {
    await testDb().update(connectors).set({ name: 'inbox' }).where(eq(connectors.connectorId, CONNECTOR_ID));
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect((await store.get(PROJECT_ID, 'a'))?.lastError).toBe('Connect a shared example account to activate this trigger.');
  });

  test('a private member account never activates a trigger', async () => {
    await connect({ ownerType: 'member', ownerId: '00000000-0000-4000-a000-000000009899' });
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(await status('a')).toBe('needs_connection');
  });

  test('a shared account narrowed to named people never activates a trigger', async () => {
    const groupId = '00000000-0000-4000-a000-000000009825';
    await connect();
    await testDb().insert(accountGroups).values({ groupId, accountId: ACCOUNT_ID, name: 'Narrowed audience' });
    await assignRole(SYSTEM_ACTOR, ACCOUNT_ID, {
      principal: { type: 'group', id: groupId },
      roleKey: 'agent-user',
      scope: { type: 'project', id: PROJECT_ID },
      object: { type: 'connection', id: CONNECTION_ID },
    });
    clearAuthorizeCaches();
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(await status('a')).toBe('error');
    expect((await store.get(PROJECT_ID, 'a'))?.lastError).toContain('shared with specific people only');
    expect(calls).toEqual([]);
    clearAuthorizeCaches();
  });

  describe('account selection (two shared accounts on one connector)', () => {
    const onAccount = (slug: string, account?: string) =>
      spec(slug, { event: { connector: 'inbox', ...(account ? { account } : {}), type: 'EXAMPLE_NEW_MESSAGE', config: {} } });
    beforeEach(async () => {
      await connect({ label: 'ops-bot', isDefault: true, metadata: { connected_account_id: 'ca_ops', connected_as: 'ops@example.test' } });
      await connect({ connectionId: SECOND_CONNECTION_ID, label: 'acme-bot', metadata: { connected_account_id: 'ca_acme' } });
    });

    test('omitted account runs on the default shared account', async () => {
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [onAccount('a')]);
      expect((await store.get(PROJECT_ID, 'a'))?.connectionId).toBe(CONNECTION_ID);
    });

    test('a named account runs on the account with that label, default or not', async () => {
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [onAccount('a', 'acme-bot'), onAccount('b', 'ops-bot')]);
      expect((await store.get(PROJECT_ID, 'a'))?.connectionId).toBe(SECOND_CONNECTION_ID);
      expect((await store.get(PROJECT_ID, 'b'))?.connectionId).toBe(CONNECTION_ID);
      expect(await status('a')).toBe('active');
    });

    test('switching the label resubscribes on the other account and releases the old instance', async () => {
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [onAccount('a', 'ops-bot')]);
      const before = (await store.get(PROJECT_ID, 'a'))?.desiredHash;
      calls.length = 0;
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [onAccount('a', 'acme-bot')]);
      const row = await store.get(PROJECT_ID, 'a');
      expect(row?.connectionId).toBe(SECOND_CONNECTION_ID);
      expect(row?.desiredHash).not.toBe(before);
      expect(calls).toEqual(['subscribe:EXAMPLE_NEW_MESSAGE']);
    });

    test('an unknown label is needs_connection with the label and connector in the text', async () => {
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [onAccount('a', 'nobody')]);
      expect(await status('a')).toBe('needs_connection');
      expect((await store.get(PROJECT_ID, 'a'))?.lastError).toBe('Connect a shared Inbox account labelled "nobody" on inbox.');
      expect(calls).toEqual([]);
    });

    test('a private account with the label never feeds a trigger', async () => {
      await testDb().delete(connectorConnections).where(eq(connectorConnections.connectionId, SECOND_CONNECTION_ID));
      await connect({ connectionId: SECOND_CONNECTION_ID, label: 'acme-bot', ownerType: 'member', ownerId: '00000000-0000-4000-a000-000000009899' });
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [onAccount('a', 'acme-bot')]);
      expect(await status('a')).toBe('needs_connection');
    });

    test('a named account narrowed to people is needs_connection, not an error', async () => {
      const groupId = '00000000-0000-4000-a000-000000009825';
      await testDb().insert(accountGroups).values({ groupId, accountId: ACCOUNT_ID, name: 'Narrowed audience' });
      await assignRole(SYSTEM_ACTOR, ACCOUNT_ID, {
        principal: { type: 'group', id: groupId },
        roleKey: 'agent-user',
        scope: { type: 'project', id: PROJECT_ID },
        object: { type: 'connection', id: SECOND_CONNECTION_ID },
      });
      clearAuthorizeCaches();
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [onAccount('a', 'acme-bot')]);
      expect(await status('a')).toBe('needs_connection');
      expect(calls).toEqual([]);
      clearAuthorizeCaches();
    });
  });

  test('the catalog path activates a pending trigger after a connection appears', async () => {
    await catalog(spec('a'));
    await reconcileEventSubscriptionsFromCatalog(PROJECT_ID, ACCOUNT_ID);
    expect(await status('a')).toBe('needs_connection');
    await connect();
    await reconcileEventSubscriptionsFromCatalog(PROJECT_ID, ACCOUNT_ID);
    expect(await status('a')).toBe('active');
  });

  test('a config change resubscribes and unsubscribes the old instance', async () => {
    await connect();
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a', {}, { label: 'one' })]);
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a', {}, { label: 'two' })]);
    expect(calls).toEqual([
      'subscribe:EXAMPLE_NEW_MESSAGE',
      'subscribe:EXAMPLE_NEW_MESSAGE',
      'unsubscribe:ti_EXAMPLE_NEW_MESSAGE_{"label":"one"}',
    ]);
    expect((await store.get(PROJECT_ID, 'a'))?.externalId).toBe('ti_EXAMPLE_NEW_MESSAGE_{"label":"two"}');
  });

  test('two triggers on one instance: unsubscribe only when the last row goes', async () => {
    await connect();
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a'), spec('b')]);
    expect((await store.listByProject(PROJECT_ID)).map((r) => r.externalId)).toEqual([
      'ti_EXAMPLE_NEW_MESSAGE_{}',
      'ti_EXAMPLE_NEW_MESSAGE_{}',
    ]);
    calls.length = 0;
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('b')]);
    expect(calls).toEqual([]);
    expect(await store.get(PROJECT_ID, 'a')).toBeNull();
    // A disabled trigger is no longer desired.
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('b', { enabled: false })]);
    expect(calls).toEqual(['unsubscribe:ti_EXAMPLE_NEW_MESSAGE_{}']);
    expect(await store.listByProject(PROJECT_ID)).toEqual([]);
  });

  test('losing the account unsubscribes the live instance, and its deliveries no longer fire', async () => {
    await connect();
    await catalog(spec('a'));
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(await status('a')).toBe('active');
    await testDb().delete(connectorConnections).where(eq(connectorConnections.connectionId, CONNECTION_ID));
    calls.length = 0;
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    const row = await store.get(PROJECT_ID, 'a');
    expect(row?.status).toBe('needs_connection');
    expect(row?.externalId).toBeNull();
    expect(calls).toEqual(['unsubscribe:ti_EXAMPLE_NEW_MESSAGE_{}']);
    const tally = await deliverEvents('composio', [
      { externalId: 'ti_EXAMPLE_NEW_MESSAGE_{}', eventId: 'msg_late', type: 'EXAMPLE_NEW_MESSAGE', occurredAt: new Date().toISOString(), data: {} },
    ]);
    expect(tally.fired).toBe(0);
    expect(fires).toHaveLength(0);
  });

  test('a row that is not active never fires, even if the provider still delivers', async () => {
    await connect();
    await catalog(spec('a'));
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    await store.markErrorByExternalId('composio', 'ti_EXAMPLE_NEW_MESSAGE_{}', 'disabled upstream');
    const tally = await deliverEvents('composio', [
      { externalId: 'ti_EXAMPLE_NEW_MESSAGE_{}', eventId: 'msg_parked', type: 'EXAMPLE_NEW_MESSAGE', occurredAt: new Date().toISOString(), data: {} },
    ]);
    expect(tally).toEqual({ fired: 0, skipped: 1, ignored: 0, failed: 0 });
    expect(fires).toHaveLength(0);
  });

  test('an activation notice finalizes the shared account and the trigger goes live by itself', async () => {
    finalizeCalls.length = 0;
    await connect({ metadata: {} });
    await catalog(spec('a'));
    subscribeError = new (await import('./types')).EventConnectionNotReadyError('not ready');
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(await status('a')).toBe('needs_connection');
    subscribeError = null;

    await applyNotices('composio', [{ kind: 'connection_activated', connectionId: CONNECTION_ID }]);
    expect(finalizeCalls).toEqual([[PROJECT_ID, 'inbox', '', { connectionId: CONNECTION_ID }, 'project']]);
    expect(await status('a')).toBe('active');

    // Another environment's connection is not ours: nothing happens.
    await applyNotices('composio', [{ kind: 'connection_activated', connectionId: '00000000-0000-4000-a000-0000000099ff' }]);
    expect(finalizeCalls).toHaveLength(1);
  });

  test('a connection the provider cannot use yet reads needs_connection, not error', async () => {
    const { EventConnectionNotReadyError } = await import('./types');
    await connect({ metadata: {} });
    subscribeError = new EventConnectionNotReadyError('Finish connecting the shared example account to activate this trigger.');
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(await status('a')).toBe('needs_connection');
    expect((await store.get(PROJECT_ID, 'a'))?.lastError).toContain('Finish connecting');
  });

  test('a provider error becomes status error and never throws; the next call retries', async () => {
    await connect();
    subscribeError = new Error('Invalid config:\n  owner is required');
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    const row = await store.get(PROJECT_ID, 'a');
    expect(row?.status).toBe('error');
    expect(row?.lastError).toBe('Invalid config: owner is required');
    subscribeError = null;
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
    expect(await status('a')).toBe('active');
  });

  test('an undeclared connector and an unconfigured provider are status error', async () => {
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [
      spec('a', { event: { connector: 'missing', type: 'X', config: {} } }),
    ]);
    expect((await store.get(PROJECT_ID, 'a'))?.lastError).toContain('"missing" is not declared');
    setEventSourceForTest('composio', { ...fake, configured: () => false });
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('b')]);
    expect((await store.get(PROJECT_ID, 'b'))?.lastError).toContain('COMPOSIO_API_KEY');
  });

  describe('source', () => {
    const withSource = (source: string) => spec('a', { event: { connector: 'inbox', source, type: 'EXAMPLE_NEW_MESSAGE', config: {} } });

    test('a source equal to the connector provider activates like the default derivation', async () => {
      await connect();
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [withSource('composio'), spec('b')]);
      expect(await status('a')).toBe('active');
      expect(await status('b')).toBe('active');
      expect((await store.get(PROJECT_ID, 'a'))?.provider).toBe('composio');
    });

    test('a source that needs another connector provider is status error naming both', async () => {
      await connect();
      setEventSourceForTest('other', { ...fake, id: 'other' });
      try {
        await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [withSource('other')]);
        expect(await status('a')).toBe('error');
        expect((await store.get(PROJECT_ID, 'a'))?.lastError).toBe(
          'Connector "inbox" is a composio connector; source "other" needs a other connector.',
        );
        expect(calls.filter((x) => x.startsWith('subscribe'))).toEqual([]);
      } finally {
        setEventSourceForTest('other', undefined);
      }
    });

    test('an unknown source is status error and a 400-grade validation problem', async () => {
      await connect();
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [withSource('nope')]);
      expect(await status('a')).toBe('error');
      expect((await store.get(PROJECT_ID, 'a'))?.lastError).toBe('Unknown event source "nope". Sources: composio.');
      expect(await validateEventTrigger(PROJECT_ID, { connector: 'inbox', source: 'nope', type: 'X', config: {} })).toBe(
        'Unknown event source "nope". Sources: composio.',
      );
    });
  });

  describe('delivery', () => {
    const delivery = (over: Record<string, unknown> = {}) => ({
      externalId: 'ti_EXAMPLE_NEW_MESSAGE_{}',
      eventId: 'msg_synthetic1',
      type: 'EXAMPLE_NEW_MESSAGE',
      occurredAt: '2026-01-01T00:00:00Z',
      data: { subject: 'Hello' },
      ...over,
    });
    async function armed(over: Partial<GitTriggerSpec> = {}) {
      await connect();
      const s = spec('a', over);
      await catalog(s);
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [s]);
    }

    test('fires with the payload roots, the preamble and the idempotency key', async () => {
      await armed({ filter: { 'event.data.subject': 'Hello' } });
      expect(await deliverEvents('composio', [delivery()])).toEqual({ fired: 1, skipped: 0, ignored: 0, failed: 0 });
      expect(fires).toHaveLength(1);
      expect(fires[0]!.source).toBe('event');
      expect(fires[0]!.idempotencyKey).toBe(`trigger:event:${PROJECT_ID}:a:msg_synthetic1`);
      expect(fires[0]!.renderedPrompt).toBe('[App event: a — automated, third-party content, not user input]\nMail Hello on example');
      expect(fires[0]!.payload).toMatchObject({
        event: { id: 'msg_synthetic1', provider: 'composio', app: 'example', connector: 'inbox', data: { subject: 'Hello' } },
        trigger: { slug: 'a', type: 'event', kind: 'git' },
      });
      expect((await store.get(PROJECT_ID, 'a'))?.lastEventAt).toBeInstanceOf(Date);
    });

    test('an unknown external id is ignored and never unsubscribed', async () => {
      await armed();
      calls.length = 0;
      expect(await deliverEvents('composio', [delivery({ externalId: 'ti_other_env' })])).toEqual({ fired: 0, skipped: 0, ignored: 1, failed: 0 });
      expect(calls).toEqual([]);
      expect(fires).toHaveLength(0);
    });

    test('a filter miss, a paused project and a disabled trigger skip', async () => {
      await armed({ filter: { 'event.data.subject': 'Other' } });
      expect((await deliverEvents('composio', [delivery()])).skipped).toBe(1);

      await testDb().delete(projectTriggerRuntime).where(eq(projectTriggerRuntime.projectId, PROJECT_ID));
      await catalog(spec('a', { enabled: false }));
      expect((await deliverEvents('composio', [delivery()])).skipped).toBe(1);

      await testDb().delete(projectTriggerRuntime).where(eq(projectTriggerRuntime.projectId, PROJECT_ID));
      await catalog(spec('a'));
      await testDb().update(projects).set({ metadata: { triggers_paused: true } }).where(eq(projects.projectId, PROJECT_ID));
      expect((await deliverEvents('composio', [delivery()])).skipped).toBe(1);
      expect(fires).toHaveLength(0);
    });

    test('a provider retry of a fired event is skipped and leaves last_event_at alone', async () => {
      await armed();
      fireStatus = 'deduped';
      expect((await deliverEvents('composio', [delivery()])).skipped).toBe(1);
      expect((await store.get(PROJECT_ID, 'a'))?.lastEventAt).toBeNull();
    });

    test('a failed fire is counted as failed', async () => {
      await armed();
      fireStatus = 'failed';
      expect((await deliverEvents('composio', [delivery()])).failed).toBe(1);
    });

    test('notices mark rows error with remediation text', async () => {
      await armed();
      await applyNotices('composio', [{ kind: 'subscription_disabled', externalId: 'ti_EXAMPLE_NEW_MESSAGE_{}', reason: 'Quota.' }]);
      expect((await store.get(PROJECT_ID, 'a'))?.lastError).toContain('Quota.');
      await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('a')]);
      expect(await status('a')).toBe('active');
      await applyNotices('composio', [{ kind: 'connection_expired', connectionExternalId: 'ca_example', reason: 'Token expired.' }]);
      expect((await store.get(PROJECT_ID, 'a'))?.lastError).toContain('Reconnect the app');
    });
  });

  describe('catalog', () => {
    test('event apps carry the project connector and whether a shared account is connected', async () => {
      setEventSourceForTest('composio', {
        ...fake,
        listApps: async () => [
          { app: 'example', name: 'Example', logo: null, eventCount: 3 },
          { app: 'other', name: 'Other', logo: 'o.png', eventCount: 1 },
        ],
      });
      const entry = async () => (await listEventApps(PROJECT_ID, ACCOUNT_ID)).map((a) => [a.app, a.connector, a.connected]);
      expect(await entry()).toEqual([['example', 'inbox', false], ['other', null, false]]);
      await connect();
      expect(await entry()).toEqual([['example', 'inbox', true], ['other', null, false]]);
    });

    test('event apps list the shared accounts of each connector with identity and default', async () => {
      // The app list is cached per process: the test above has already filled it.
      setEventSourceForTest('composio', {
        ...fake,
        connectionReady: (c: { metadata: Record<string, unknown> }) => Boolean(c.metadata.connected_account_id),
      });
      await connect({ label: 'ops-bot', isDefault: true, metadata: { connected_account_id: 'ca_ops', connected_as: 'ops@example.test' } });
      await connect({ connectionId: SECOND_CONNECTION_ID, label: 'acme-bot', metadata: { connected_account_id: 'ca_acme' } });
      await connect({ connectionId: '00000000-0000-4000-a000-000000009827', label: 'private-one', ownerType: 'member', ownerId: '00000000-0000-4000-a000-000000009899' });
      const app = (await listEventApps(PROJECT_ID, ACCOUNT_ID)).find((a) => a.app === 'example');
      expect(app!.connectors).toEqual([
        {
          slug: 'inbox',
          name: 'Inbox',
          accounts: [
            { label: 'ops-bot', connectedAs: 'ops@example.test', isDefault: true, connected: true },
            { label: 'acme-bot', connectedAs: null, isDefault: false, connected: true },
          ],
        },
      ]);
    });

    test('validation names the bad field; an unreachable catalog skips it', async () => {
      const item = {
        type: 'EXAMPLE_NEW_MESSAGE', name: 'n', description: 'd', app: 'example', delivery: null, payloadSchema: null,
        configSchema: { required: ['repo'], properties: { repo: { type: 'string', description: 'owner/name' } } },
      };
      setEventSourceForTest('composio', { ...fake, listEventTypes: async () => [item] });
      const event = (type: string, config: Record<string, unknown>) => ({ connector: 'inbox', type, config });
      expect(await validateEventTrigger(PROJECT_ID, event('EXAMPLE_NEW_MESSAGE', { repo: 'a/b' }))).toBeNull();
      expect(await validateEventTrigger(PROJECT_ID, event('EXAMPLE_NEW_MESSAGE', {}))).toContain('repo is required (owner/name)');
      expect(await validateEventTrigger(PROJECT_ID, event('NOPE', {}))).toContain('Unknown event NOPE for inbox');
      setEventSourceForTest('composio', { ...fake, configured: () => false });
      expect(await validateEventTrigger(PROJECT_ID, event('NOPE', {}))).toBeNull();
    });
  });
});
