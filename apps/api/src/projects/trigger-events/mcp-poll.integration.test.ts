/**
 * Kortix-polled app events (source `mcp`) on real PostgreSQL: reconcile →
 * poll stream → a check through the real connector gateway against a
 * loopback MCP server → a delivery job → the trigger fires (fireGitTrigger
 * is the one fake). Covers the first check, dedup, the tool gate, transient
 * failures, the claim fence, pause, and the connectors_v2 gate.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  connectorActions,
  connectorCalls,
  connectorConnections,
  connectors,
  jobQueue,
  projectTriggerEventPolls,
  projectTriggerRuntime,
  projects,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { config } from '../../config';
import { db } from '../../shared/db';
import type { GitTriggerSpec } from '../trigger-types';

const fires: Array<Record<string, any>> = [];
let fireStatus: 'fired' | 'retryable' = 'fired';
const actualTriggers = await import('../lib/triggers');
mock.module('../lib/triggers', () => ({
  ...actualTriggers,
  fireGitTrigger: async (input: Record<string, any>) => {
    fires.push(input);
    if (fireStatus === 'retryable') return { status: 'failed', error: 'The sandbox provider is busy', retryable: true };
    return { status: 'fired', sessionId: 'sess_synthetic', deduped: false };
  },
}));

const { reconcileEventSubscriptions } = await import('./subscriptions');
const { runPoll } = await import('./mcp-poll');
const { claimDueStreams } = await import('./poll-store');
const { listEventApps } = await import('./catalog');
const { runJobBatch } = await import('../../shared/job-queue');
const store = await import('./store');

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009921';
const PROJECT_ID = '00000000-0000-4000-a000-000000009922';
const CONNECTOR_ID = '00000000-0000-4000-a000-000000009923';
const CONNECTION_ID = '00000000-0000-4000-a000-000000009924';
const OWNER_ID = '00000000-0000-4000-a000-000000009925';
const FLAGS = { event_triggers: true, connectors_v2: true, notification_center: true };

// The loopback MCP server: `list_items` answers `items`, newest first.
let items: Array<Record<string, unknown>> = [];
let answer: 'ok' | '401' | '503' = 'ok';
const toolCalls: Array<{ name: string; arguments: unknown }> = [];
const mcp = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = (await req.json()) as { id?: number; method: string; params?: { name: string; arguments: unknown } };
    if (body.method !== 'tools/call') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
    toolCalls.push(body.params!);
    if (answer === '401') return new Response('unauthorized', { status: 401 });
    if (answer === '503') return new Response('unavailable', { status: 503 });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: { items } } });
  },
});

const spec = (slug: string, type = 'new_item.list_items', config: Record<string, unknown> = { interval: 1 }): GitTriggerSpec => ({
  slug,
  path: `kortix.yaml#triggers.${slug}`,
  name: slug,
  type: 'event',
  agent: 'default',
  model: null,
  enabled: true,
  promptTemplate: 'New item {{ event.data.id }}',
  cron: null,
  runAt: null,
  timezone: 'UTC',
  secretEnv: null,
  run: null,
  monitorMode: null,
  intervalSeconds: null,
  expectEventWithinSeconds: null,
  event: { connector: 'fake', type, config },
  sessionMode: 'fresh',
  pinnedSessionId: null,
  sessionKey: null,
  filter: null,
});

async function cleanup() {
  await db.delete(jobQueue).where(eq(jobQueue.queue, 'trigger-events.deliver'));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function reconcile(specs: GitTriggerSpec[]) {
  for (const s of specs) {
    await db
      .insert(projectTriggerRuntime)
      .values({ projectId: PROJECT_ID, slug: s.slug, triggerType: 'event', enabled: true, scheduleSpec: s as unknown as Record<string, unknown> })
      .onConflictDoNothing();
  }
  await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, specs);
}

/** Make every stream of the project due, claim them, and run one check each. */
async function checkNow() {
  await db.update(projectTriggerEventPolls).set({ nextPollAt: sql`now()`, lockedUntil: null }).where(eq(projectTriggerEventPolls.projectId, PROJECT_ID));
  for (const stream of (await claimDueStreams(50, 60_000)).filter((s) => s.projectId === PROJECT_ID)) await runPoll(stream);
}

const stream = async () => (await db.select().from(projectTriggerEventPolls).where(eq(projectTriggerEventPolls.projectId, PROJECT_ID)))[0];
const deliverJobs = () => db.select().from(jobQueue).where(eq(jobQueue.queue, 'trigger-events.deliver'));
const row = (slug: string) => store.get(PROJECT_ID, slug);
const recent = (id: string, ageMs = 1_000) => ({ id, createdAt: new Date(Date.now() - ageMs).toISOString() });

let previousAllow: readonly string[] = [];
beforeAll(() => {
  previousAllow = config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS;
  (config as { KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: readonly string[] }).KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS = ['127.0.0.1'];
});
afterAll(() => {
  (config as { KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: readonly string[] }).KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS = previousAllow;
  mcp.stop(true);
});

describe('mcp event source — real PostgreSQL, loopback MCP server', () => {
  beforeEach(async () => {
    await cleanup();
    fires.length = 0;
    toolCalls.length = 0;
    fireStatus = 'fired';
    answer = 'ok';
    items = [recent('old-1', 10 * 60_000), { id: 'untimed-1' }];
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'mcp-poll-test' });
    await insertIntoView(db, accountMembers, { userId: OWNER_ID, accountId: ACCOUNT_ID, accountRole: 'owner' });
    await db.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'mcp-poll',
      repoUrl: 'https://example.test/mcp-poll.git',
      metadata: { experimental: FLAGS },
    });
    await db.insert(connectors).values({
      connectorId: CONNECTOR_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: 'fake',
      name: 'Fake',
      providerType: 'mcp',
      config: { url: `http://127.0.0.1:${mcp.port}/mcp`, transport: 'http', auth: { type: 'none', in: 'header', name: null, prefix: null } },
    });
    await db.insert(connectorActions).values([
      {
        connectorId: CONNECTOR_ID,
        path: 'list_items',
        name: 'list_items',
        description: 'List items. Newest first.',
        risk: 'read',
        inputSchema: { type: 'object', properties: { folder: { type: 'string' }, cursor: { type: 'string' } } },
        binding: { kind: 'mcp', tool: 'list_items' },
      },
      { connectorId: CONNECTOR_ID, path: 'drop_items', name: 'drop_items', risk: 'destructive', binding: { kind: 'mcp', tool: 'drop_items' } },
    ]);
    await db.insert(connectorConnections).values({
      connectionId: CONNECTION_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      connectorId: CONNECTOR_ID,
      label: 'Shared',
      ownerType: 'project',
      isDefault: true,
    });
  });
  afterEach(cleanup);

  test('subscribe creates one stream; the first check fires nothing old; a new item fires once', async () => {
    await reconcile([spec('watch')]);
    const sub = await row('watch');
    expect(sub).toMatchObject({ status: 'active', provider: 'mcp', connectionId: CONNECTION_ID });
    expect(sub?.externalId).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(await stream()).toMatchObject({ externalId: sub?.externalId, intervalSeconds: 60, primedAt: null, connectorSlug: 'fake' });

    await checkNow();
    expect(toolCalls).toEqual([{ name: 'list_items', arguments: {} }]);
    expect((await stream())?.primedAt).not.toBeNull();
    expect(await deliverJobs()).toEqual([]);

    items = [recent('new-1'), ...items];
    await checkNow();
    const jobs = await deliverJobs();
    expect(jobs.map((j) => j.jobKey)).toEqual([`${sub!.externalId}:new-1`]);
    // One ok audit row, for the check that fired; empty checks write none.
    const audits = await db.select().from(connectorCalls).where(eq(connectorCalls.projectId, PROJECT_ID));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: 'ok', actionPath: 'fake.list_items', sessionId: null, actingUserId: OWNER_ID });
    expect(audits[0]?.resultSummary).toMatchObject({ origin: 'event_poll', external_id: sub!.externalId, fired: 1 });

    expect(await runJobBatch()).toBeGreaterThan(0);
    expect(fires).toHaveLength(1);
    expect(fires[0]?.idempotencyKey).toBe(`trigger:event:${PROJECT_ID}:watch:new-1`);
    expect(fires[0]?.payload.event).toMatchObject({ provider: 'mcp', app: 'fake', type: 'new_item.list_items', data: { id: 'new-1' } });
    expect(fires[0]?.renderedPrompt).toContain('New item new-1');

    await checkNow();
    expect(await deliverJobs()).toHaveLength(1);
  });

  test('an item that arrives right after the save fires on the first check', async () => {
    await reconcile([spec('watch')]);
    items = [recent('just-now', 0), ...items];
    await checkNow();
    expect((await deliverJobs()).map((j) => j.jobKey.split(':')[1])).toEqual(['just-now']);
  });

  test('two triggers on the same event and settings share one stream and both fire', async () => {
    await reconcile([spec('one'), spec('two', 'new_item.list_items', { interval: 5 })]);
    expect((await row('one'))?.externalId).toBe((await row('two'))?.externalId);
    expect(await db.select().from(projectTriggerEventPolls).where(eq(projectTriggerEventPolls.projectId, PROJECT_ID))).toHaveLength(1);
    await checkNow();
    items = [recent('shared-1'), ...items];
    await checkNow();
    await runJobBatch();
    expect(fires.map((f) => f.idempotencyKey).sort()).toEqual([
      `trigger:event:${PROJECT_ID}:one:shared-1`,
      `trigger:event:${PROJECT_ID}:two:shared-1`,
    ]);
  });

  test('a tool that can change data is refused at subscribe and never called', async () => {
    await reconcile([spec('bad', 'new_item.drop_items')]);
    expect(await row('bad')).toMatchObject({ status: 'error', lastError: expect.stringContaining('drop_items can change data in fake') });
    await checkNow();
    expect(toolCalls).toEqual([]);
  });

  test('vendor failures back off, report after 3 in a row, keep checking, and recover', async () => {
    await reconcile([spec('watch')]);
    await checkNow();
    answer = '401';
    await checkNow();
    expect((await row('watch'))?.status).toBe('active');
    const first = await stream();
    expect(first).toMatchObject({ failures: 1, lastErrorKind: 'transient' });
    expect(first!.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    await checkNow();
    await checkNow();
    expect(await row('watch')).toMatchObject({ status: 'error', lastError: expect.stringContaining('The last 3 checks of fake failed') });
    expect((await stream())?.nextPollAt).not.toBeNull();

    answer = 'ok';
    items = [recent('after-outage'), ...items];
    await checkNow();
    expect(await row('watch')).toMatchObject({ status: 'active', lastError: null });
    expect(await stream()).toMatchObject({ failures: 0, lastError: null });
    expect((await deliverJobs()).map((j) => j.jobKey.split(':')[1])).toEqual(['after-outage']);
  });

  test('a stale claim commits nothing: its deliveries roll back with its state', async () => {
    await reconcile([spec('watch')]);
    await checkNow();
    items = [recent('race-1'), ...items];
    await db.update(projectTriggerEventPolls).set({ nextPollAt: sql`now()` }).where(eq(projectTriggerEventPolls.projectId, PROJECT_ID));
    const [stale] = await claimDueStreams(50, 60_000);
    // The lease ran out and another replica claimed the stream.
    await db.update(projectTriggerEventPolls).set({ lockedUntil: sql`now() - interval '1 second'` }).where(eq(projectTriggerEventPolls.projectId, PROJECT_ID));
    const [fresh] = await claimDueStreams(50, 60_000);
    await runPoll(stale!);
    expect(await deliverJobs()).toEqual([]);
    await runPoll(fresh!);
    expect((await deliverJobs()).map((j) => j.jobKey.split(':')[1])).toEqual(['race-1']);
  });

  test('paused triggers make no vendor call, and the first check after resume fires nothing old', async () => {
    await reconcile([spec('watch')]);
    await checkNow();
    await db.update(projects).set({ metadata: { experimental: FLAGS, triggers_paused: true } }).where(eq(projects.projectId, PROJECT_ID));
    items = [recent('while-paused', 5 * 60_000), ...items];
    toolCalls.length = 0;
    await checkNow();
    expect(toolCalls).toEqual([]);
    expect((await stream())?.primedAt).toBeNull();
    await db.update(projects).set({ metadata: { experimental: FLAGS } }).where(eq(projects.projectId, PROJECT_ID));
    await checkNow();
    expect(await deliverJobs()).toEqual([]);
  });

  test('a failed fire retries from the delivery job, not from the vendor', async () => {
    await reconcile([spec('watch')]);
    await checkNow();
    items = [recent('retry-me'), ...items];
    await checkNow();
    fireStatus = 'retryable';
    toolCalls.length = 0;
    await runJobBatch();
    const [job] = await deliverJobs();
    expect(job).toMatchObject({ status: 'queued', attempts: 1, maxAttempts: 5 });
    expect(toolCalls).toEqual([]);
  });

  test('removing the trigger drops the stream; connectors_v2 off gives the legacy text', async () => {
    await reconcile([spec('watch')]);
    expect(await stream()).toBeDefined();
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, []);
    expect(await stream()).toBeUndefined();

    await reconcile([spec('watch')]);
    await db.update(projects).set({ metadata: { experimental: { ...FLAGS, connectors_v2: false } } }).where(eq(projects.projectId, PROJECT_ID));
    await reconcileEventSubscriptions(PROJECT_ID, ACCOUNT_ID, [spec('watch')]);
    expect(await row('watch')).toMatchObject({ status: 'error', externalId: null, lastError: 'Connector "fake" (mcp) has no app-event source. Use an app connector.' });
    expect(await stream()).toBeUndefined();
  });

  test('event apps: a project MCP server is an event app with one event per list tool; off without connectors_v2', async () => {
    const apps = await listEventApps(PROJECT_ID, ACCOUNT_ID);
    const fake = apps.find((a) => a.provider === 'mcp' && a.app === 'fake');
    expect(fake).toMatchObject({ connector: 'fake', eventCount: 1, connected: true, mcpUrl: null });
    expect(apps.find((a) => a.app === 'linear')).toMatchObject({ provider: 'mcp', connector: null, eventCount: 0, mcpUrl: 'https://mcp.linear.app/mcp' });

    await db.update(projects).set({ metadata: { experimental: { ...FLAGS, connectors_v2: false } } }).where(eq(projects.projectId, PROJECT_ID));
    expect((await listEventApps(PROJECT_ID, ACCOUNT_ID)).filter((a) => a.provider === 'mcp')).toEqual([]);
  });
});

