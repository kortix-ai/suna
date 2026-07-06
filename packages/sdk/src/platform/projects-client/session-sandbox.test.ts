import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import { clearSessionRuntime, getSessionRuntime } from '../../state/session-runtime-registry';
import { sessionStartKey, startProjectSession } from './session-sandbox';

const PROJECT = 'P1';
const SESSION = 'S1';

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

afterEach(() => {
  clearSessionRuntime(PROJECT, SESSION);
});

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

function readySandbox(overrides: Partial<{ external_id: string | null }> = {}) {
  return {
    sandbox_id: 'sbx-db-1',
    session_id: SESSION,
    project_id: PROJECT,
    account_id: 'acct-1',
    provider: 'daytona' as const,
    external_id: 'ext-1',
    base_url: null,
    status: 'active' as const,
    config: {},
    metadata: {},
    last_used_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

test('startProjectSession POSTs to /start with no query string when waitMs is omitted', async () => {
  nextResponse = {
    status: 200,
    body: { stage: 'provisioning', agent_name: 'default', retriable: true, sandbox: null, opencode_session_id: null },
  };
  await startProjectSession(PROJECT, SESSION);
  expect(last().url).toBe(`http://test.local/v1/projects/${PROJECT}/sessions/${SESSION}/start`);
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
});

test('startProjectSession appends ?wait_ms=<floored ms> when waitMs is given', async () => {
  nextResponse = {
    status: 200,
    body: { stage: 'provisioning', agent_name: 'default', retriable: true, sandbox: null, opencode_session_id: null },
  };
  await startProjectSession(PROJECT, SESSION, 5_500.9);
  expect(last().url).toContain('/start?wait_ms=5500');
});

test('startProjectSession omits the query string for a zero or negative waitMs', async () => {
  nextResponse = {
    status: 200,
    body: { stage: 'provisioning', agent_name: 'default', retriable: true, sandbox: null, opencode_session_id: null },
  };
  await startProjectSession(PROJECT, SESSION, 0);
  expect(last().url).not.toContain('wait_ms');

  await startProjectSession(PROJECT, SESSION, -100);
  expect(last().url).not.toContain('wait_ms');
});

test('startProjectSession returns null when the response is unsuccessful (never throws)', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  const result = await startProjectSession(PROJECT, SESSION);
  expect(result).toBeNull();
});

test('startProjectSession returns null when the response has no data', async () => {
  nextResponse = { status: 200, body: null };
  const result = await startProjectSession(PROJECT, SESSION);
  expect(result).toBeNull();
});

test('startProjectSession returns the parsed result even when stage is not ready (no registry write)', async () => {
  nextResponse = {
    status: 200,
    body: { stage: 'starting', agent_name: 'default', retriable: true, sandbox: readySandbox(), opencode_session_id: null },
  };
  const result = await startProjectSession(PROJECT, SESSION);
  expect(result?.stage).toBe('starting');
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('startProjectSession populates the shared session-runtime registry once stage is ready with a sandbox external_id + opencode_session_id', async () => {
  nextResponse = {
    status: 200,
    body: {
      stage: 'ready',
      agent_name: 'default',
      retriable: false,
      sandbox: readySandbox({ external_id: 'ext-ready-1' }),
      opencode_session_id: 'ocs-ready-1',
    },
  };
  const result = await startProjectSession(PROJECT, SESSION);
  expect(result?.stage).toBe('ready');

  const entry = getSessionRuntime(PROJECT, SESSION);
  expect(entry).toBeDefined();
  expect(entry?.opencodeSessionId).toBe('ocs-ready-1');
  expect(entry?.sandboxId).toBe('ext-ready-1');
  expect(entry?.runtimeUrl).toBe('http://test.local/v1/p/ext-ready-1/8000');
});

test('startProjectSession does NOT populate the registry when ready but sandbox has no external_id', async () => {
  nextResponse = {
    status: 200,
    body: {
      stage: 'ready',
      agent_name: 'default',
      retriable: false,
      sandbox: readySandbox({ external_id: null }),
      opencode_session_id: 'ocs-2',
    },
  };
  await startProjectSession(PROJECT, SESSION);
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('startProjectSession does NOT populate the registry when ready but opencode_session_id is missing', async () => {
  nextResponse = {
    status: 200,
    body: {
      stage: 'ready',
      agent_name: 'default',
      retriable: false,
      sandbox: readySandbox({ external_id: 'ext-3' }),
      opencode_session_id: null,
    },
  };
  await startProjectSession(PROJECT, SESSION);
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('startProjectSession does NOT populate the registry when ready but sandbox itself is null', async () => {
  nextResponse = {
    status: 200,
    body: { stage: 'ready', agent_name: 'default', retriable: false, sandbox: null, opencode_session_id: 'ocs-4' },
  };
  await startProjectSession(PROJECT, SESSION);
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('sessionStartKey returns a stable tuple keyed by project + session id', () => {
  expect(sessionStartKey('PA', 'SA')).toEqual(['session-start', 'PA', 'SA']);
  expect(sessionStartKey('PA', 'SA')).toEqual(sessionStartKey('PA', 'SA'));
  expect(sessionStartKey('PA', 'SA')).not.toEqual(sessionStartKey('PB', 'SA'));
});
