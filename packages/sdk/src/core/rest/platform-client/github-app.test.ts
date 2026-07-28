import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  createManagedGitHubConnectSession,
  createManagedGitHubReconnectSession,
  disconnectGitHubApp,
  disconnectManagedGitHubConnection,
  getGitHubAppStatus,
  getManagedGitHubStatus,
  listManagedGitHubCandidates,
  selectManagedGitHubCandidate,
  setGitHubAppFromExisting,
  setGitHubAppPat,
  startGitHubAppManifest,
} from './github-app';

const candidate = {
  connection_id: 'managed-connection',
  integration_id: 'github-app',
  display_name: 'Kortix Managed GitHub',
  installation_id: '12345',
  owner: { login: 'kortix-managed', type: 'Organization' as const },
  status: 'connected' as const,
  selected: false,
  repository_selection: 'all',
  permissions: { contents: 'write' },
};

let requests: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  requests = [];
  configureKortix({
    backendUrl: 'http://test.local/v1',
    getToken: async () => 'kortix-token',
  });
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : null;
      const bodyText = request ? await request.clone().text() : String(init?.body ?? '');
      const method = request?.method ?? init?.method ?? 'GET';
      requests.push({
        url: String(request?.url ?? input),
        method,
        body: bodyText ? JSON.parse(bodyText) : null,
      });

      if (method === 'DELETE') return Response.json({ ok: true });
      if (String(request?.url ?? input).endsWith('/candidates')) {
        return Response.json({ candidates: [candidate] });
      }
      if (String(request?.url ?? input).endsWith('/status')) {
        return Response.json({
          configured: true,
          owner: 'kortix-managed',
          slug: null,
          installation_id: '12345',
          source: 'nango',
          selected: { ...candidate, selected: true },
        });
      }
      if (String(request?.url ?? input).endsWith('/select')) {
        return Response.json({ candidate: { ...candidate, selected: true } });
      }
      return Response.json({
        token: 'connect-token',
        expires_at: '2026-07-27T22:00:00.000Z',
        connect_link: 'https://connect.nango.dev/session',
      });
    },
  ) as unknown as typeof fetch;
});

test('uses credential-free managed Nango platform routes', async () => {
  const session = await createManagedGitHubConnectSession();
  const candidates = await listManagedGitHubCandidates();
  const selected = await selectManagedGitHubCandidate('managed-connection');
  await createManagedGitHubReconnectSession('managed-connection');
  await disconnectManagedGitHubConnection();

  expect(session.connect_link).toBe('https://connect.nango.dev/session');
  expect(candidates).toEqual([candidate]);
  expect(selected.candidate.selected).toBe(true);
  expect(requests).toEqual([
    {
      url: 'http://test.local/v1/platform/github-app/connect-session',
      method: 'POST',
      body: {},
    },
    {
      url: 'http://test.local/v1/platform/github-app/candidates',
      method: 'GET',
      body: null,
    },
    {
      url: 'http://test.local/v1/platform/github-app/select',
      method: 'POST',
      body: { connection_id: 'managed-connection' },
    },
    {
      url: 'http://test.local/v1/platform/github-app/reconnect-session',
      method: 'POST',
      body: { connection_id: 'managed-connection' },
    },
    {
      url: 'http://test.local/v1/platform/github-app/connection',
      method: 'DELETE',
      body: null,
    },
  ]);
  expect(JSON.stringify(requests)).not.toContain('private_key');
  expect(JSON.stringify(requests)).not.toContain('token:');
});

test('exposes the managed Nango surface through createKortix', async () => {
  const kortix = createKortix({
    backendUrl: 'http://test.local/v1',
    getToken: async () => 'kortix-token',
  });

  expect(await kortix.platform.github.status()).toMatchObject({
    configured: true,
    source: 'nango',
  });
  expect(typeof kortix.platform.github.createConnectSession).toBe('function');
  expect(typeof kortix.platform.github.listCandidates).toBe('function');
  expect(typeof kortix.platform.github.selectCandidate).toBe('function');
  expect(typeof kortix.platform.github.createReconnectSession).toBe('function');
  expect(typeof kortix.platform.github.disconnect).toBe('function');
});

test('keeps the existing platform GitHub names exported as deprecated adapters', async () => {
  expect(typeof getGitHubAppStatus).toBe('function');
  expect(typeof startGitHubAppManifest).toBe('function');
  expect(typeof setGitHubAppFromExisting).toBe('function');
  expect(typeof setGitHubAppPat).toBe('function');
  expect(typeof disconnectGitHubApp).toBe('function');

  expect(await getManagedGitHubStatus()).toMatchObject({
    configured: true,
    owner: 'kortix-managed',
    installation_id: '12345',
    source: 'nango',
  });
});

test('deprecated setup adapters never transmit GitHub credentials', async () => {
  const errors = await Promise.all([
    startGitHubAppManifest({ org: 'acme' }).catch((error) => error),
    setGitHubAppFromExisting({
      appId: '123',
      privateKey: 'private-key',
      installationId: '456',
    }).catch((error) => error),
    setGitHubAppPat({ owner: 'acme', token: 'github-token' }).catch((error) => error),
  ]);

  for (const error of errors) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'github_connection_required',
      details: {
        requires_human_oauth: true,
        sdk_action: 'createManagedGitHubConnectSession',
      },
    });
  }
  expect(requests).toEqual([]);
});
