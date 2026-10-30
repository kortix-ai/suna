import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import type { UnifiedTrigger } from './runtime-triggers';
import {
  createRuntimeTrigger,
  deleteRuntimeTrigger,
  listUnifiedTriggers,
  runRuntimeTrigger,
  updateRuntimeTrigger,
} from './runtime-triggers';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextBody: unknown = {};

beforeEach(() => {
  calls = [];
  nextBody = {};
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(nextBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

const WOKEN: UnifiedTrigger = {
  id: 'trigger.0123456789ab',
  origin: 'runtime',
  name: null,
  prompt: 'Build {{ body.ref }}',
  agent: 'kortix',
  state: 'active',
  source: { type: 'webhook', secret_env: 'CI_SECRET', webhook_url: 'http://x/v1/webhooks/projects/p1/trigger.0123456789ab' },
  target: { kind: 'session', session_id: 's1', session_name: 'Fix the build' },
  next_fire_at: null,
  last_fired_at: null,
  last_status: null,
  last_error: null,
};

test('listUnifiedTriggers GETs kortix.yaml and runtime triggers together', async () => {
  nextBody = { triggers: [WOKEN], triggers_paused: false, account_automations_paused: false, errors: [] };
  const result = await listUnifiedTriggers('p1');
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/projects/p1/triggers/all' });
  expect(result.triggers[0]?.target).toEqual({ kind: 'session', session_id: 's1', session_name: 'Fix the build' });
});

test('createRuntimeTrigger POSTs a source and a target', async () => {
  nextBody = WOKEN;
  await createRuntimeTrigger('p1', {
    prompt: 'CR merged',
    source: { type: 'change_request', cr_id: 'cr1' },
    target: { session_id: 's1' },
  });
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://test.local/projects/p1/triggers/runtime',
    body: { prompt: 'CR merged', source: { type: 'change_request', cr_id: 'cr1' }, target: { session_id: 's1' } },
  });
});

test('update, run and delete address one runtime trigger by id', async () => {
  await updateRuntimeTrigger('p1', 'trigger.0123456789ab', { enabled: false });
  expect(last()).toMatchObject({ method: 'PATCH', url: 'http://test.local/projects/p1/triggers/runtime/trigger.0123456789ab', body: { enabled: false } });
  await runRuntimeTrigger('p1', 'trigger.0123456789ab');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/projects/p1/triggers/runtime/trigger.0123456789ab/run' });
  await deleteRuntimeTrigger('p1', 'trigger.0123456789ab');
  expect(last()).toMatchObject({ method: 'DELETE', url: 'http://test.local/projects/p1/triggers/runtime/trigger.0123456789ab' });
});

test('the facade binds the project: kortix.project(id).triggers', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  nextBody = { triggers: [] };
  await kortix.project('p1').triggers.all();
  expect(last().url).toBe('http://test.local/projects/p1/triggers/all');
  await kortix.project('p1').triggers.createRuntime({ prompt: 'x', source: { type: 'schedule', every: '1h' }, target: { agent: 'default' } });
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/projects/p1/triggers/runtime' });
  await kortix.project('p1').triggers.runRuntime('trigger.0123456789ab');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/projects/p1/triggers/runtime/trigger.0123456789ab/run' });
});
