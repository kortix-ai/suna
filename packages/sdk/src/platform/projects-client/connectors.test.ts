import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import {
  createConnector,
  deleteConnector,
  getConnectorConfig,
  getConnectorPolicies,
  getConnectStatus,
  listConnectors,
  listPipedreamApps,
  pipedreamConnect,
  pipedreamFinalize,
  setConnectorCredential,
  setConnectorCredentialMode,
  setConnectorName,
  setConnectorPolicies,
  setConnectorSensitive,
  syncConnectors,
} from './connectors';

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

test('listConnectors GETs the project connectors list', async () => {
  nextResponse = { status: 200, body: { connectors: [] } };
  const result = await listConnectors('P1');
  expect(last().url).toContain('/executor/projects/P1/connectors');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ connectors: [] });
});

test('listConnectors throws on a failed response', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listConnectors('P1')).rejects.toBeTruthy();
});

test('listConnectors is a silent background read — a 403 never hits the global error sink', async () => {
  // Fired at workspace mount (project-home tiles, sidebar setup checklist);
  // callers render their own state, never a global toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { error: 'forbidden' } };
    await expect(listConnectors('P1')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('syncConnectors POSTs an empty body to the sync endpoint', async () => {
  nextResponse = { status: 200, body: { synced: 2, errors: [] } };
  const result = await syncConnectors('P1');
  expect(last().url).toContain('/executor/projects/P1/connectors/sync');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result).toEqual({ synced: 2, errors: [] });
});

test('setConnectorCredentialMode PUTs { mode }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorCredentialMode('P1', 'slack', 'shared');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/credential-mode');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ mode: 'shared' });
});

test('setConnectorSensitive PUTs { sensitive }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorSensitive('P1', 'slack', true);
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/sensitive');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ sensitive: true });
});

test('getConnectorPolicies GETs the policies list', async () => {
  nextResponse = { status: 200, body: { policies: [{ match: '*', action: 'require_approval' }] } };
  const result = await getConnectorPolicies('P1', 'slack');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/policies');
  expect(last().method).toBe('GET');
  expect(result.policies).toHaveLength(1);
});

test('setConnectorPolicies PUTs { policies }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  const policies = [{ match: 'send_message', action: 'block' as const }];
  await setConnectorPolicies('P1', 'slack', policies);
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/policies');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ policies });
});

test('getConnectorConfig GETs the config, url-encoding a slug with special characters', async () => {
  nextResponse = {
    status: 200,
    body: {
      slug: 'my app/v1',
      provider: 'mcp',
      platform: null,
      credentialMode: 'shared',
      app: null,
      account: null,
      url: null,
      transport: 'http',
      endpoint: null,
      baseUrl: null,
      spec: null,
      auth: { type: 'none', in: 'header', name: null, prefix: null },
    },
  };
  const result = await getConnectorConfig('P1', 'my app/v1');
  expect(last().url).toContain(
    `/executor/projects/P1/connectors/${encodeURIComponent('my app/v1')}/config`,
  );
  expect(last().url).not.toContain('my app/v1');
  expect(last().method).toBe('GET');
  expect(result.slug).toBe('my app/v1');
});

test('setConnectorName PUTs { name }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorName('P1', 'slack', 'Team Slack');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/name');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ name: 'Team Slack' });
});

test('pipedreamConnect POSTs an empty body to the connect endpoint', async () => {
  nextResponse = { status: 200, body: { connectUrl: 'https://pipedream.com/connect/x' } };
  const result = await pipedreamConnect('P1', 'github');
  expect(last().url).toContain('/executor/projects/P1/connectors/github/connect');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.connectUrl).toContain('pipedream.com');
});

test('createConnector POSTs the draft as the raw body', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  const draft = { slug: 'my-http', provider: 'http' as const, url: 'https://example.com' };
  await createConnector('P1', draft);
  expect(last().url).toContain('/executor/projects/P1/connectors');
  expect(last().url).not.toContain('/connectors/');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(draft);
});

test('deleteConnector DELETEs the connector by slug', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteConnector('P1', 'slack');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack');
  expect(last().method).toBe('DELETE');
});

test('listPipedreamApps GETs with no query string when no optional params are given', async () => {
  nextResponse = { status: 200, body: { apps: [], hasMore: false } };
  await listPipedreamApps('P1');
  expect(last().url).toContain('/executor/projects/P1/pipedream/apps');
  expect(last().url).not.toContain('?');
  expect(last().method).toBe('GET');
});

test('listPipedreamApps GETs with q + cursor as query params when given', async () => {
  nextResponse = { status: 200, body: { apps: [], nextCursor: 'c2', hasMore: true } };
  const result = await listPipedreamApps('P1', 'slack', 'c1');
  expect(last().url).toContain('/executor/projects/P1/pipedream/apps?');
  expect(last().url).toContain('q=slack');
  expect(last().url).toContain('cursor=c1');
  expect(result.nextCursor).toBe('c2');
});

test('getConnectStatus GETs the deployment-wide connect-status endpoint', async () => {
  nextResponse = { status: 200, body: { configured: true, provider: 'pipedream' } };
  const result = await getConnectStatus();
  expect(last().url).toContain('/executor/connect-status');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ configured: true, provider: 'pipedream' });
});

test('setConnectorCredential PUTs { value }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorCredential('P1', 'slack', 'sekret');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/credential');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ value: 'sekret' });
});

test('pipedreamFinalize POSTs an empty body to the connect/finalize endpoint', async () => {
  nextResponse = { status: 200, body: { connected: true, accountId: 'acc_1' } };
  const result = await pipedreamFinalize('P1', 'github');
  expect(last().url).toContain('/executor/projects/P1/connectors/github/connect/finalize');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result).toEqual({ connected: true, accountId: 'acc_1' });
});
