import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import type { Automation } from './automations';
import {
  createProjectAutomation,
  deleteProjectAutomation,
  listProjectAutomations,
  runProjectAutomation,
  updateProjectAutomation,
} from './automations';

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

const WOKEN: Automation = {
  id: 'automation.0123456789ab',
  origin: 'runtime',
  name: null,
  prompt: 'Build {{ body.ref }}',
  agent: 'kortix',
  state: 'active',
  source: { type: 'webhook', secret_env: 'CI_SECRET', webhook_url: 'http://x/v1/webhooks/projects/p1/automation.0123456789ab' },
  target: { kind: 'session', session_id: 's1', session_name: 'Fix the build' },
  next_fire_at: null,
  last_fired_at: null,
  last_status: null,
  last_error: null,
};

test('listProjectAutomations GETs declared and runtime automations together', async () => {
  nextBody = { automations: [WOKEN], triggers_paused: false, account_automations_paused: false, errors: [] };
  const result = await listProjectAutomations('p1');
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/projects/p1/automations' });
  expect(result.automations[0]?.target).toEqual({ kind: 'session', session_id: 's1', session_name: 'Fix the build' });
});

test('createProjectAutomation POSTs a source and a target', async () => {
  nextBody = WOKEN;
  await createProjectAutomation('p1', {
    prompt: 'CR merged',
    source: { type: 'change_request', cr_id: 'cr1' },
    target: { session_id: 's1' },
  });
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://test.local/projects/p1/automations',
    body: { prompt: 'CR merged', source: { type: 'change_request', cr_id: 'cr1' }, target: { session_id: 's1' } },
  });
});

test('update, run and delete address one runtime automation by id', async () => {
  await updateProjectAutomation('p1', 'automation.0123456789ab', { enabled: false });
  expect(last()).toMatchObject({ method: 'PATCH', url: 'http://test.local/projects/p1/automations/automation.0123456789ab', body: { enabled: false } });
  await runProjectAutomation('p1', 'automation.0123456789ab');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/projects/p1/automations/automation.0123456789ab/run' });
  await deleteProjectAutomation('p1', 'automation.0123456789ab');
  expect(last()).toMatchObject({ method: 'DELETE', url: 'http://test.local/projects/p1/automations/automation.0123456789ab' });
});

test('the facade binds the project: kortix.project(id).automations', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  nextBody = { automations: [] };
  await kortix.project('p1').automations.list();
  expect(last().url).toBe('http://test.local/projects/p1/automations');
  await kortix.project('p1').automations.create({ prompt: 'x', source: { type: 'schedule', every: '1h' }, target: { agent: 'default' } });
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/projects/p1/automations' });
});
