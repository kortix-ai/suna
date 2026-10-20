import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import type {
  CreateProjectTriggerInput,
  ProjectMonitorMode,
  ProjectTrigger,
  ProjectTriggerEventApp,
  ProjectTriggerType,
  TriggerFilterValue,
  UpdateProjectTriggerInput,
} from './triggers';
import {
  createProjectTrigger,
  getAccountAutomations,
  setAccountAutomationsPaused,
  fireProjectTrigger,
  listProjectTriggerRuns,
  listTriggerRuns,
  replayTriggerRun,
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

// KRTX-1721: overlap — skip holds a fire while the previous run is active.
test('createProjectTrigger and updateProjectTrigger send overlap; the listing reads it', async () => {
  nextResponse = { status: 200, body: { triggers: [{ ...MONITOR_WIRE_ENTRY, overlap: 'allow' }], errors: [] } };
  await createProjectTrigger('P1', { name: 'Nightly', type: 'cron', cron: '0 0 3 * * *', prompt_template: 'Go', overlap: 'skip' });
  expect(last().body).toMatchObject({ overlap: 'skip' });
  await updateProjectTrigger('P1', 'nightly', { overlap: null });
  expect(last().body).toEqual({ overlap: null });
  const [trigger] = (await listProjectTriggers('P1')).triggers;
  const overlap: 'skip' | 'allow' | null | undefined = trigger!.overlap;
  // @ts-expect-error overlap is skip or allow
  const bad: CreateProjectTriggerInput['overlap'] = 'queue';
  expect(overlap).toBe('allow');
  expect([overlap, bad]).toHaveLength(2);
});

// KRTX-1721: a trigger that paused itself after a sustained run-limit breach.
test('listProjectTriggers keeps the auto-pause the API reports', async () => {
  const reason = 'auto-paused: ran at max_runs_per_hour 60 for 2 hours in a row';
  nextResponse = {
    status: 200,
    body: { triggers: [{ ...MONITOR_WIRE_ENTRY, auto_paused_at: '2026-10-19T12:00:00.000Z', auto_paused_reason: reason }], errors: [] },
  };

  const [trigger] = (await listProjectTriggers('P1')).triggers;
  const pausedAt: string | null | undefined = trigger!.auto_paused_at;
  const why: string | null | undefined = trigger!.auto_paused_reason;

  expect([pausedAt, why]).toEqual(['2026-10-19T12:00:00.000Z', reason]);
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

test('createProjectTrigger and updateProjectTrigger send filter operators unchanged (KRTX-1721)', async () => {
  nextResponse = { status: 200, body: { triggers: [], errors: [], triggers_paused: false } };
  const filter: Record<string, TriggerFilterValue> = {
    'body.type': 'push',
    'body.ref': { not_prefix: ['refs/heads/kortix/'] },
    'body.sender.login': { not: ['kortix-bot'] },
    'body.action': { in: ['opened', 'reopened'] },
    'body.pull_request': { exists: true },
  };

  await createProjectTrigger('P1', { name: 'On push', slug: 'on-push', type: 'webhook', prompt_template: 'Lint {{ body.ref }}', filter });
  expect(last().body).toMatchObject({ filter });
  await updateProjectTrigger('P1', 'on-push', { filter: { 'body.base': { prefix: ['release/'] } } });
  expect(last().body).toEqual({ filter: { 'body.base': { prefix: ['release/'] } } });

  const read: ProjectTrigger['filter'] = filter;
  // @ts-expect-error an operator takes a list of strings, not a bare object
  const badOperand: TriggerFilterValue = { not: { login: 'kortix-bot' } };
  expect([read, badOperand]).toHaveLength(2);
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

test('listProjectTriggerEventApps reads mcp_url: the catalogue server for source mcp, null otherwise, absent from an older API', async () => {
  nextResponse = {
    status: 200,
    body: {
      apps: [
        { source: 'mcp', provider: 'mcp', app: 'linear', name: 'Linear', logo: 'l.png', event_count: 0, connector: null, connected: false, mcp_url: 'https://mcp.linear.app/mcp' },
        { source: 'mcp', provider: 'mcp', app: 'tickets', name: 'Tickets', logo: null, event_count: 2, connector: 'tickets', connected: true, mcp_url: null },
        { source: 'composio', provider: 'composio', app: 'github', name: 'GitHub', logo: null, event_count: 4, connector: 'github', connected: true, mcp_url: null },
        { source: 'composio', provider: 'composio', app: 'slack', name: 'Slack', logo: null, event_count: 3, connector: 'slack', connected: true },
      ],
    },
  };

  const { apps } = await listProjectTriggerEventApps('P1');

  const urls: ProjectTriggerEventApp['mcp_url'][] = apps.map((a) => a.mcp_url);
  expect(urls).toEqual(['https://mcp.linear.app/mcp', null, null, undefined]);
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

test('the listing reads when a Kortix-polled trigger checked its app and checks next', async () => {
  const event: NonNullable<ProjectTrigger['event']> = {
    connector: 'inbox',
    type: 'new_item.list_items',
    config: { interval: 5 },
    source: 'mcp',
    provider: 'mcp',
    app: 'inbox',
    status: 'active',
    error: null,
    last_event_at: null,
    checked_at: '2026-10-19T04:00:00.000Z',
    next_check_at: '2026-10-19T04:05:00.000Z',
  };
  nextResponse = { status: 200, body: { triggers: [{ ...MONITOR_WIRE_ENTRY, type: 'event', event }], errors: [] } };

  const listing = await listProjectTriggers('P1');

  expect(listing.triggers[0]!.event?.checked_at).toBe('2026-10-19T04:00:00.000Z');
  expect(listing.triggers[0]!.event?.next_check_at).toBe('2026-10-19T04:05:00.000Z');
});

test('updateProjectTrigger accepts event_config', async () => {
  const input: UpdateProjectTriggerInput = { event_config: { repo: 'acme/other' } };
  await updateProjectTrigger('P1', 's', input);
  expect(last().body).toEqual(input);
});

// ── Run history, fire with payload / dry run, replay (KRTX-1743) ──────────────

/** One serialized run, exactly as `TriggerRunSchema` emits it (synthetic ids). */
const RUN_WIRE_ENTRY = {
  run_id: '00000000-0000-4000-8000-000000000001',
  slug: 'nightly',
  source: 'manual',
  status: 'fired',
  run_status: 'succeeded',
  error: null,
  run_error: null,
  session_id: 'session-1',
  command_id: null,
  replay_of: null,
  payload_verified: true,
  payload: { body: { ticket: 'T-9', api_key: '[redacted]' } },
  scheduled_for: '2026-10-16T18:03:54.382Z',
  created_at: '2026-10-16T18:03:54.382Z',
  started_at: '2026-10-16T18:03:54.382Z',
  ended_at: '2026-10-16T18:08:54.382Z',
  duration_ms: 300000,
  cost_usd: 0.25,
};

test('listTriggerRuns GETs one trigger\'s runs with cursor and limit, and returns the page', async () => {
  nextResponse = { status: 200, body: { runs: [RUN_WIRE_ENTRY], next_cursor: 'c2' } };

  const page = await listTriggerRuns('P1', 'nightly', { cursor: 'c 1/=', limit: 10 });

  expect(last().method).toBe('GET');
  expect(last().url).toBe('http://test.local/projects/P1/triggers/nightly/runs?limit=10&cursor=c+1%2F%3D');
  expect(page.next_cursor).toBe('c2');
  expect(page.runs[0]).toEqual(RUN_WIRE_ENTRY as never);
});

test('listTriggerRuns without options sends no query string', async () => {
  nextResponse = { status: 200, body: { runs: [], next_cursor: null } };
  await listTriggerRuns('P1', 'nightly');
  expect(last().url).toBe('http://test.local/projects/P1/triggers/nightly/runs');
});

test('listProjectTriggerRuns GETs every run of the project, filtered by status', async () => {
  nextResponse = { status: 200, body: { runs: [], next_cursor: null } };

  await listProjectTriggerRuns('P1', { status: 'failed', cursor: 'c1', limit: 25 });
  expect(last().method).toBe('GET');
  expect(last().url).toBe('http://test.local/projects/P1/trigger-runs?status=failed&limit=25&cursor=c1');

  await listProjectTriggerRuns('P1');
  expect(last().url).toBe('http://test.local/projects/P1/trigger-runs');
});

test('fireProjectTrigger without options still POSTs an empty body (plain manual fire)', async () => {
  nextResponse = {
    status: 202,
    body: { status: 'deduped', command_id: 'cmd-1', session_id: null, deduped: true, run_id: 'run-1' },
  };

  const result = await fireProjectTrigger('P1', 'nightly');

  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/P1/triggers/nightly/fire');
  expect(last().body).toEqual({});
  expect(result.status).toBe('deduped');
  expect(result.deduped).toBe(true);
  expect(result.command_id).toBe('cmd-1');
  expect(result.run_id).toBe('run-1');
});

test('fireProjectTrigger sends payload and dry_run, and returns the dry-run result', async () => {
  const dry = {
    dry_run: true,
    rendered_prompt: 'Ticket T-1 from manual',
    filter_matches: true,
    session_key: 'T-1',
    payload: { source: 'manual', body: { ticket: 'T-1' } },
  };
  nextResponse = { status: 200, body: dry };

  const result = await fireProjectTrigger('P1', 'tickets', {
    payload: { body: { ticket: 'T-1' } },
    dryRun: true,
  });

  expect(last().body).toEqual({ payload: { body: { ticket: 'T-1' } }, dry_run: true });
  expect(result.dry_run).toBe(true);
  expect(result.rendered_prompt).toBe('Ticket T-1 from manual');
  expect(result.filter_matches).toBe(true);
  expect(result.session_key).toBe('T-1');
});

test('fireProjectTrigger with a payload alone sends no dry_run key', async () => {
  nextResponse = { status: 202, body: { status: 'fired', command_id: null, session_id: 's', deduped: false, run_id: 'r' } };
  await fireProjectTrigger('P1', 'tickets', { payload: { body: { ticket: 'T-2' } } });
  expect(last().body).toEqual({ payload: { body: { ticket: 'T-2' } } });
});

test('replayTriggerRun POSTs the replay route, with confirm_unverified only when asked', async () => {
  nextResponse = { status: 202, body: { status: 'fired', command_id: null, session_id: 's', deduped: false, run_id: 'run-2' } };

  const result = await replayTriggerRun('P1', 'nightly', 'run-1');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/P1/triggers/nightly/runs/run-1/replay');
  expect(last().body).toEqual({});
  expect(result.run_id).toBe('run-2');

  await replayTriggerRun('P1', 'nightly', 'run-1', { confirmUnverified: true });
  expect(last().body).toEqual({ confirm_unverified: true });
});

test('replayTriggerRun throws on 409 payload_unverified', async () => {
  nextResponse = { status: 409, body: { error: 'Payload unverified', code: 'payload_unverified' } };
  await expect(replayTriggerRun('P1', 'nightly', 'run-1')).rejects.toBeDefined();
});

// KRTX-1721: run caps are typed on create, update (null removes one) and the listing.
test('createProjectTrigger sends the run caps, updateProjectTrigger removes one with null, and the listing reads them', async () => {
  nextResponse = { status: 200, body: { triggers: [], errors: [] } };
  await createProjectTrigger('P1', {
    name: 'Hook', type: 'webhook', prompt_template: 'x', secret_env: 'HOOK_SECRET',
    max_runs_per_hour: 5, max_runs_per_day: 40,
  });
  expect(last().body).toMatchObject({ max_runs_per_hour: 5, max_runs_per_day: 40 });

  nextResponse = {
    status: 200,
    body: { triggers: [{ slug: 'hook', max_runs_per_hour: 5, max_runs_per_day: null }], errors: [] },
  };
  const listing = await updateProjectTrigger('P1', 'hook', { max_runs_per_day: null });
  expect(last().body).toEqual({ max_runs_per_day: null });
  const caps: Array<number | null | undefined> = [listing.triggers[0]!.max_runs_per_hour, listing.triggers[0]!.max_runs_per_day];
  expect(caps).toEqual([5, null]);
});

// KRTX-1721: the account's Pause all automations.
test('getAccountAutomations reads the switch and setAccountAutomationsPaused flips it', async () => {
  nextResponse = { status: 200, body: { paused: false, paused_at: null, paused_by: null, can_change: true } };
  const status = await getAccountAutomations('A1');
  expect(last().url).toContain('/accounts/A1/automations');
  expect(last().method ?? 'GET').toBe('GET');
  expect(status.paused).toBe(false);

  nextResponse = { status: 200, body: { paused: true, paused_at: '2026-10-19T10:00:00.000Z', paused_by: 'U1', can_change: true } };
  const after = await setAccountAutomationsPaused('A1', true);
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ paused: true });
  expect([after.paused, after.paused_by]).toEqual([true, 'U1']);
});
