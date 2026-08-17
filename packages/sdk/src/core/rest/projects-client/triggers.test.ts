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
