import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { createManagedGithubRouter } from '../platform/routes/managed-github';
import { githubInsufficientPermissions } from '../projects/nango/errors';
import type {
  ManagedGithubCandidate,
  ManagedGithubConnectionService,
} from '../platform/services/managed-github-connection';
import type { AppEnv } from '../types';

const adminUserId = 'f5f875ba-e054-41ca-a441-6e032f969d88';
const candidate: ManagedGithubCandidate = {
  connectionId: 'managed-connection',
  integrationId: 'github-app',
  displayName: 'Kortix Managed GitHub',
  installationId: '12345',
  owner: { login: 'kortix-managed', type: 'Organization' },
  status: 'connected',
  selected: true,
  repositorySelection: 'all',
  permissions: { contents: 'write' },
};

function makeService() {
  const calls: string[] = [];
  const service = {
    createConnectSession: async (userId: string) => {
      calls.push(`connect:${userId}`);
      return {
        token: 'connect-token',
        expiresAt: '2026-07-27T22:00:00.000Z',
        connectLink: 'https://connect.nango.dev/session',
      };
    },
    createReconnectSession: async (connectionId: string, userId: string) => {
      calls.push(`reconnect:${connectionId}:${userId}`);
      return {
        token: 'reconnect-token',
        expiresAt: '2026-07-27T22:00:00.000Z',
        connectLink: 'https://connect.nango.dev/reconnect',
      };
    },
    listCandidates: async () => {
      calls.push('list');
      return [candidate];
    },
    selectCandidate: async (connectionId: string, userId: string) => {
      calls.push(`select:${connectionId}:${userId}`);
      return candidate;
    },
    getStatus: async () => {
      calls.push('status');
      return { configured: true, selected: candidate, candidates: [candidate] };
    },
    disconnectSelected: async () => {
      calls.push('disconnect');
    },
    resolveSelectedCredential: async () => {
      throw new Error('not used by routes');
    },
  } as ManagedGithubConnectionService;
  return { service, calls };
}

const authenticate: MiddlewareHandler<AppEnv> = async (context, next) => {
  context.set('userId', adminUserId);
  context.set('userEmail', 'admin@example.test');
  await next();
};

const allowAdmin: MiddlewareHandler<AppEnv> = async (_context, next) => {
  await next();
};

function app(
  service: ManagedGithubConnectionService,
  adminMiddleware: MiddlewareHandler<AppEnv> = allowAdmin,
) {
  const root = new Hono();
  root.route(
    '/v1/platform/github-app',
    createManagedGithubRouter({
      service,
      authMiddleware: authenticate,
      adminMiddleware,
    }),
  );
  return root;
}

describe('managed GitHub platform routes', () => {
  let fixture: ReturnType<typeof makeService>;

  beforeEach(() => {
    fixture = makeService();
  });

  test('denies all managed lifecycle operations before service access for a non-admin', async () => {
    const rejectAdmin: MiddlewareHandler<AppEnv> = async (context) =>
      context.json({ message: 'Admin access required' }, 403);
    const router = app(fixture.service, rejectAdmin);
    const requests: Array<[string, RequestInit | undefined]> = [
      ['/v1/platform/github-app/status', undefined],
      ['/v1/platform/github-app/connect-session', { method: 'POST', body: '{}' }],
      ['/v1/platform/github-app/candidates', undefined],
      [
        '/v1/platform/github-app/select',
        { method: 'POST', body: JSON.stringify({ connection_id: 'managed-connection' }) },
      ],
      [
        '/v1/platform/github-app/reconnect-session',
        { method: 'POST', body: JSON.stringify({ connection_id: 'managed-connection' }) },
      ],
      ['/v1/platform/github-app/connection', { method: 'DELETE' }],
    ];

    for (const [path, init] of requests) {
      const response = await router.request(path, {
        ...init,
        headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      });
      expect(response.status).toBe(403);
    }
    expect(fixture.calls).toEqual([]);
  });

  test('returns only credential-free status and candidate metadata', async () => {
    const router = app(fixture.service);
    const statusResponse = await router.request('/v1/platform/github-app/status');
    const candidatesResponse = await router.request('/v1/platform/github-app/candidates');

    expect(statusResponse.status).toBe(200);
    const statusBody = await statusResponse.json();
    expect(statusBody).toEqual({
      configured: true,
      owner: 'kortix-managed',
      slug: null,
      installation_id: '12345',
      source: 'nango',
      selected: {
        connection_id: 'managed-connection',
        integration_id: 'github-app',
        display_name: 'Kortix Managed GitHub',
        installation_id: '12345',
        owner: { login: 'kortix-managed', type: 'Organization' },
        status: 'connected',
        selected: true,
        repository_selection: 'all',
        permissions: { contents: 'write' },
      },
      candidates: [
        {
          connection_id: 'managed-connection',
          integration_id: 'github-app',
          display_name: 'Kortix Managed GitHub',
          installation_id: '12345',
          owner: { login: 'kortix-managed', type: 'Organization' },
          status: 'connected',
          selected: true,
          repository_selection: 'all',
          permissions: { contents: 'write' },
        },
      ],
    });
    const candidatesBody = await candidatesResponse.json();
    expect(candidatesBody).toEqual({
      candidates: [
        {
          connection_id: 'managed-connection',
          integration_id: 'github-app',
          display_name: 'Kortix Managed GitHub',
          installation_id: '12345',
          owner: { login: 'kortix-managed', type: 'Organization' },
          status: 'connected',
          selected: true,
          repository_selection: 'all',
          permissions: { contents: 'write' },
        },
      ],
    });
    expect(JSON.stringify({ statusBody, candidatesBody })).not.toContain('installation-token');
  });

  test('passes the authenticated admin identity to connect, select, and reconnect', async () => {
    const router = app(fixture.service);

    const connect = await router.request('/v1/platform/github-app/connect-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const select = await router.request('/v1/platform/github-app/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connection_id: 'managed-connection' }),
    });
    const reconnect = await router.request('/v1/platform/github-app/reconnect-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connection_id: 'managed-connection' }),
    });
    const disconnect = await router.request('/v1/platform/github-app/connection', {
      method: 'DELETE',
    });

    expect(connect.status).toBe(200);
    expect(select.status).toBe(200);
    expect(reconnect.status).toBe(200);
    expect(disconnect.status).toBe(200);
    expect(fixture.calls).toEqual([
      `connect:${adminUserId}`,
      `select:managed-connection:${adminUserId}`,
      `reconnect:managed-connection:${adminUserId}`,
      'disconnect',
    ]);
  });

  test('maps an unusable GitHub App permission set to the stable error contract', async () => {
    const router = app({
      ...fixture.service,
      selectCandidate: async () => {
        throw githubInsufficientPermissions();
      },
    });

    const response = await router.request('/v1/platform/github-app/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connection_id: 'managed-connection' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'The GitHub connection does not grant the required permissions.',
      code: 'github_insufficient_permissions',
    });
  });
});
