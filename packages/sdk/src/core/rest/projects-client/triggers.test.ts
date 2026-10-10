import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import type {
  CreateProjectTriggerInput,
  ProjectMonitorMode,
  ProjectTrigger,
  ProjectTriggerType,
  UpdateProjectTriggerInput,
} from './triggers';
import {
  createProjectTrigger,
  listProjectTriggerEventApps,
  listProjectTriggerEventTypes,
  listProjectTriggers,
  updateProjectTrigger,
} from './triggers';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

/** One serialized `type: monitor` entry, exactly as `TriggerSchema` emits it. */
const MONITOR_WIRE_ENTRY = {
  slug: 'checkout-errors',
  path: 'kortix.yaml#triggers.checkout-errors',
  name: 'Checkout errors',
  type: 'monitor',
  agent: 'oncall',
  model: null,
  enabled: true,
  cron: null,
  run_at: null,
  timezone: 'UTC',
  secret_env: null,
  run: './monitors/checkout-errors.ts',
  mode: 'poll',
  interval_seconds: 60,
  expect_event_within_seconds: 86400,
  event: null,
  prompt_template: 'Checkout monitor emitted: {{ line }}',
  session_mode: 'reuse',
  session_id: null,
  session_key: null,
  filter: null,
  last_fired_at: null,
  webhook_url: null,
  session_access: {
    mode: 'members',
    memberIds: ['member-1'],
    groupIds: ['group-1'],
  },
};

test('listProjectTriggers reads a monitor entry off the wire without losing its fields', async () => {
  nextResponse = {
    status: 200,
    body: { triggers: [MONITOR_WIRE_ENTRY], errors: [], triggers_paused: false },
  };

  const listing = await listProjectTriggers('P1');

  expect(last().url).toContain('/projects/P1/triggers');
  expect(last().method).toBe('GET');
  const monitor = listing.triggers[0]!;
  expect(monitor.type).toBe('monitor');
  expect(monitor.run).toBe('./monitors/checkout-errors.ts');
  expect(monitor.mode).toBe('poll');
  expect(monitor.interval_seconds).toBe(60);
  expect(monitor.expect_event_within_seconds).toBe(86400);
  // A monitor defaults to `reuse`, not `fresh` — it fires repeatedly by design.
  expect(monitor.session_mode).toBe('reuse');
  expect(monitor.session_access).toEqual({
    mode: 'members',
    memberIds: ['member-1'],
    groupIds: ['group-1'],
  });
});

// The API reports the last fire or run outcome; a host shows a failed trigger.
test('listProjectTriggers keeps the last run outcome the API reports', async () => {
  nextResponse = {
    status: 200,
    body: {
      triggers: [
        {
          ...MONITOR_WIRE_ENTRY,
          last_status: 'failed',
          last_error: 'Out of credits: Payment Required: Insufficient credits.',
          last_attempt_at: '2026-10-01T06:00:00.000Z',
        },
      ],
      errors: [],
    },
  };

  const [trigger] = (await listProjectTriggers('P1')).triggers;

  expect(trigger!.last_status).toBe('failed');
  expect(trigger!.last_error).toBe('Out of credits: Payment Required: Insufficient credits.');
  expect(trigger!.last_attempt_at).toBe('2026-10-01T06:00:00.000Z');
});

test('a cron entry still parses with the monitor fields serialized as null', async () => {
  nextResponse = {
    status: 200,
    body: {
      triggers: [
        {
          ...MONITOR_WIRE_ENTRY,
          slug: 'daily-digest',
          type: 'cron',
          cron: '0 0 9 * * 1-5',
          run: null,
          mode: null,
          interval_seconds: null,
          expect_event_within_seconds: null,
          session_mode: 'fresh',
        },
      ],
      errors: [],
      triggers_paused: false,
    },
  };

  const listing = await listProjectTriggers('P1');
  const cron = listing.triggers[0]!;
  expect(cron.type).toBe('cron');
  expect(cron.cron).toBe('0 0 9 * * 1-5');
  expect(cron.run).toBeNull();
  expect(cron.mode).toBeNull();
  expect(cron.interval_seconds).toBeNull();
  expect(cron.expect_event_within_seconds).toBeNull();
});

test('createProjectTrigger POSTs the monitor draft fields the API parser accepts', async () => {
  nextResponse = { status: 200, body: { triggers: [], errors: [], triggers_paused: false } };

  await createProjectTrigger('P1', {
    name: 'Checkout errors',
    slug: 'checkout-errors',
    type: 'monitor',
    prompt_template: 'Checkout monitor emitted: {{ line }}',
    agent: 'oncall',
    run: './monitors/checkout-errors.ts',
    mode: 'poll',
    // Durations are literals ("30s"/"5m"/"24h"), never bare numbers — the
    // manifest is a human-review surface.
    interval: '60s',
    expect_event_within: '24h',
    session_access: {
      mode: 'members',
      memberIds: ['member-1'],
      groupIds: ['group-1'],
    },
  });

  expect(last().url).toContain('/projects/P1/triggers');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    name: 'Checkout errors',
    slug: 'checkout-errors',
    type: 'monitor',
    prompt_template: 'Checkout monitor emitted: {{ line }}',
    agent: 'oncall',
    run: './monitors/checkout-errors.ts',
    mode: 'poll',
    interval: '60s',
    expect_event_within: '24h',
    session_access: {
      mode: 'members',
      memberIds: ['member-1'],
      groupIds: ['group-1'],
    },
  });
});

test('updateProjectTrigger PATCHes monitor fields, and null clears the silence watchdog', async () => {
  nextResponse = { status: 200, body: { triggers: [], errors: [], triggers_paused: false } };

  await updateProjectTrigger('P1', 'checkout-errors', {
    mode: 'stream',
    interval: null,
    expect_event_within: null,
    run: './monitors/checkout-stream.ts',
    session_access: { mode: 'project', memberIds: [], groupIds: [] },
  });

  expect(last().url).toContain('/projects/P1/triggers/checkout-errors');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({
    mode: 'stream',
    interval: null,
    expect_event_within: null,
    run: './monitors/checkout-stream.ts',
    session_access: { mode: 'project', memberIds: [], groupIds: [] },
  });
});

test('updateProjectTrigger can restore private trigger-created sessions', async () => {
  nextResponse = { status: 200, body: { triggers: [], errors: [], triggers_paused: false } };

  await updateProjectTrigger('P1', 'checkout-errors', {
    session_access: { mode: 'private', memberIds: [], groupIds: [] },
  });

  expect(last().body).toEqual({
    session_access: { mode: 'private', memberIds: [], groupIds: [] },
  });
});

test('the public trigger types name monitor as a first-class third type', () => {
  const type: ProjectTriggerType = 'monitor';
  const poll: ProjectMonitorMode = 'poll';
  const stream: ProjectMonitorMode = 'stream';
  const createMode: CreateProjectTriggerInput['mode'] = 'poll';
  const updateMode: UpdateProjectTriggerInput['mode'] = 'stream';
  const readMode: ProjectTrigger['mode'] = null;

  expect([type, poll, stream, createMode, updateMode, readMode]).toEqual([
    'monitor',
    'poll',
    'stream',
    'poll',
    'stream',
    null,
  ]);
});

test('a mode outside poll/stream is rejected by the compiler', () => {
  // @ts-expect-error "tail" is not a monitor mode
  const badRead: ProjectMonitorMode = 'tail';
  // @ts-expect-error "tail" is not a monitor mode
  const badCreate: CreateProjectTriggerInput['mode'] = 'tail';

  expect([badRead, badCreate]).toHaveLength(2);
});

test('the public trigger access type rejects unknown modes', () => {
  const access: ProjectTrigger['session_access'] = {
    mode: 'private',
    memberIds: [],
    groupIds: [],
  };
  const badAccess: CreateProjectTriggerInput['session_access'] = {
    // @ts-expect-error "account" is not a trigger session access mode
    mode: 'account',
  };

  expect([access, badAccess]).toHaveLength(2);
});

test('listProjectTriggerEventTypes GETs event-types with the connector query and returns the typed catalog', async () => {
  nextResponse = {
    status: 200,
    body: {
      provider: 'composio',
      app: 'github',
      event_types: [
        {
          type: 'GITHUB_PULL_REQUEST_EVENT',
          name: 'Pull request',
          description: 'A pull request changed.',
          app: 'github',
          delivery: 'push',
          config_schema: { type: 'object' },
          payload_schema: null,
        },
      ],
    },
  };

  const catalog = await listProjectTriggerEventTypes('P1', { connector: 'my github' });

  expect(last().method).toBe('GET');
  expect(last().url).toContain('/projects/P1/triggers/event-types?connector=my%20github');
  expect(catalog.provider).toBe('composio');
  expect(catalog.event_types[0]!.delivery).toBe('push');
});

test('listProjectTriggerEventTypes with { app, source } GETs event-types?app= and needs no connector', async () => {
  nextResponse = { status: 200, body: { source: 'composio', provider: 'composio', app: 'github', event_types: [] } };

  await listProjectTriggerEventTypes('P1', { app: 'git hub' });
  expect(last().url).toContain('/projects/P1/triggers/event-types?app=git%20hub');
  expect(last().url).not.toContain('connector');

  await listProjectTriggerEventTypes('P1', { app: 'github', source: 'composio' });
  expect(last().url).toContain('/projects/P1/triggers/event-types?app=github&source=composio');
});

test('listProjectTriggerEventApps GETs event-apps and returns connector and connection state', async () => {
  nextResponse = {
    status: 200,
    body: {
      apps: [
        { provider: 'composio', app: 'github', name: 'GitHub', logo: null, event_count: 4, connector: 'github', connected: true },
        { provider: 'composio', app: 'linear', name: 'Linear', logo: 'l.png', event_count: 2, connector: null, connected: false },
      ],
    },
  };

  const { apps } = await listProjectTriggerEventApps('P1');

  expect(last().method).toBe('GET');
  expect(last().url).toContain('/projects/P1/triggers/event-apps');
  expect(apps[0]!.connected).toBe(true);
  expect(apps[1]!.connector).toBeNull();
});

test('listProjectTriggerEventApps returns each connector profile with its shared accounts', async () => {
  nextResponse = {
    status: 200,
    body: {
      apps: [
        {
          provider: 'composio', app: 'github', name: 'GitHub', logo: null, event_count: 4, connector: 'github-work', connected: true,
          connectors: [
            { slug: 'github-work', name: 'GitHub work', accounts: [
              { label: 'ops-bot', connected_as: 'ops@example.test', is_default: true, connected: true },
              { label: 'acme-bot', connected_as: null, is_default: false, connected: true },
            ] },
            { slug: 'github-oss', name: 'GitHub OSS', accounts: [] },
          ],
        },
      ],
    },
  };

  const { apps } = await listProjectTriggerEventApps('P1');

  const [work, oss] = apps[0]!.connectors!;
  expect(work!.accounts.map((a) => [a.label, a.is_default])).toEqual([['ops-bot', true], ['acme-bot', false]]);
  expect(oss!.accounts).toEqual([]);
});

test('createProjectTrigger sends event_account and updateProjectTrigger clears it with null', async () => {
  nextResponse = { status: 200, body: { triggers: [], errors: [] } };
  await createProjectTrigger('P1', {
    name: 'PR opened', type: 'event', prompt_template: 'x', connector: 'github-work',
    event_account: 'acme-bot', event: 'GITHUB_PULL_REQUEST_EVENT',
  });
  expect(last().body).toMatchObject({ connector: 'github-work', event_account: 'acme-bot' });

  nextResponse = { status: 200, body: { triggers: [], errors: [] } };
  await updateProjectTrigger('P1', 'pr-review', { event_account: null });
  expect(last().body).toEqual({ event_account: null });
});

test('event_source is sent on create, cleared with null on update, and read back as event.source', async () => {
  nextResponse = { status: 200, body: { triggers: [], errors: [] } };
  await createProjectTrigger('P1', {
    name: 'PR opened', type: 'event', prompt_template: 'x', connector: 'github-work',
    event_source: 'composio', event: 'GITHUB_PULL_REQUEST_CREATED',
  });
  expect(last().body).toMatchObject({ connector: 'github-work', event_source: 'composio' });

  nextResponse = { status: 200, body: { triggers: [], errors: [] } };
  await updateProjectTrigger('P1', 'pr-review', { event_source: null });
  expect(last().body).toEqual({ event_source: null });

  nextResponse = { status: 200, body: { triggers: [{ slug: 'pr-review', type: 'event', event: { connector: 'github-work', type: 'X', config: {}, source: 'composio', provider: 'composio', app: 'github', status: 'active', error: null, last_event_at: null } }], errors: [] } };
  const listed = await listProjectTriggers('P1');
  expect(listed.triggers[0]!.event?.source).toBe('composio');
});

test('listProjectTriggerEventTypes and EventApps expose source next to the deprecated provider', async () => {
  nextResponse = { status: 200, body: { source: 'composio', provider: 'composio', app: 'github', event_types: [] } };
  const catalog = await listProjectTriggerEventTypes('P1', { connector: 'github-work' });
  expect(catalog.source).toBe('composio');
  nextResponse = { status: 200, body: { apps: [{ source: 'composio', provider: 'composio', app: 'github', name: 'GitHub', logo: null, event_count: 1, connector: null, connected: false }] } };
  expect((await listProjectTriggerEventApps('P1')).apps[0]!.source).toBe('composio');
});

test('createProjectTrigger sends an event trigger body and the listing reads event state back', async () => {
  const input: CreateProjectTriggerInput = {
    name: 'PR opened',
    type: 'event',
    prompt_template: 'Review {{ event.data.title }}',
    connector: 'github',
    event: 'GITHUB_PULL_REQUEST_EVENT',
    event_config: { repo: 'acme/app' },
  };
  const event: NonNullable<ProjectTrigger['event']> = {
    connector: 'github',
    type: 'GITHUB_PULL_REQUEST_EVENT',
    config: { repo: 'acme/app' },
    provider: 'composio',
    app: 'github',
    status: 'needs_connection',
    error: null,
    last_event_at: null,
  };
  nextResponse = {
    status: 200,
    body: { triggers: [{ ...MONITOR_WIRE_ENTRY, type: 'event', event }], errors: [] },
  };

  const listing = await createProjectTrigger('P1', input);

  expect(last().body).toEqual(input);
  const type: ProjectTriggerType = listing.triggers[0]!.type;
  expect(type).toBe('event');
  expect(listing.triggers[0]!.event?.status).toBe('needs_connection');
});

test('updateProjectTrigger accepts event_config', async () => {
  const input: UpdateProjectTriggerInput = { event_config: { repo: 'acme/other' } };
  await updateProjectTrigger('P1', 's', input);
  expect(last().body).toEqual(input);
});
