import { describe, expect, test } from 'bun:test';
import type { AppHostingProvider } from './hosting';
import { prepareAppWsUpgrade, type AppWsUpgradeDependencies } from './ws-proxy';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_ALLOW_LOCAL_EDGE = 'true';

const REQUEST_URL = 'https://aaaaaaaaaaaaaaaa.apps.localhost/socket?channel=events';

function loadedApp(runtimeStatus: 'running' | 'stopped' = 'stopped') {
  return {
    app: {
      appId: '11111111-1111-4111-8111-111111111111',
      accountId: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333',
      name: 'Socket App',
      accessMode: 'private',
      accessPasswordHash: null,
      accessRevision: 1,
      createdBy: '44444444-4444-4444-8444-444444444444',
      idleTimeoutSeconds: 300,
      updatedAt: new Date(),
    },
    deployment: { deploymentId: '55555555-5555-4555-8555-555555555555' },
    runtime: {
      runtimeId: '66666666-6666-4666-8666-666666666666',
      provider: 'platinum',
      externalId: 'socket-app-runtime',
      status: runtimeStatus,
      idleDeadlineAt: runtimeStatus === 'running' ? new Date(Date.now() + 60_000) : null,
    },
  } as any;
}

function dependencies(
  overrides: Partial<AppWsUpgradeDependencies> = {},
): AppWsUpgradeDependencies {
  const loaded = loadedApp();
  return {
    loadPublicApp: async () => loaded,
    authorizeAppRequest: async () => null,
    createHosting: () => ({
      ingress: async () => ({
        url: 'https://runtime.example.test',
        headers: { authorization: 'Bearer runtime' },
      }),
    }) as unknown as AppHostingProvider,
    ensureAppRuntimeRunning: async () => loaded.runtime,
    enqueueCurrentAppRuntime: async () => true,
    stampActivity: async () => {},
    ...overrides,
  };
}

describe('Apps WebSocket edge contract', () => {
  test('rejects App access before wake, activity, or upstream ingress', async () => {
    const events: string[] = [];
    const result = await prepareAppWsUpgrade(
      new Request(REQUEST_URL),
      new URL(REQUEST_URL),
      dependencies({
        authorizeAppRequest: async () => {
          events.push('authorize');
          return Response.json({ code: 'app_auth_required' }, { status: 401 });
        },
        ensureAppRuntimeRunning: async () => {
          events.push('wake');
          throw new Error('must not wake');
        },
        stampActivity: async () => {
          events.push('activity');
        },
        createHosting: () => {
          events.push('hosting');
          throw new Error('must not create hosting');
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      message: 'App authentication required',
    });
    expect(events).toEqual(['authorize']);
  });

  test('cold starts, queues the current daemon, stamps activity, and preserves the path', async () => {
    const events: string[] = [];
    const loaded = loadedApp('stopped');
    const result = await prepareAppWsUpgrade(
      new Request(REQUEST_URL),
      new URL(REQUEST_URL),
      dependencies({
        loadPublicApp: async () => loaded,
        authorizeAppRequest: async () => {
          events.push('authorize');
          return null;
        },
        createHosting: () => ({
          ingress: async () => {
            events.push('ingress');
            return {
              url: 'https://runtime.example.test/base/',
              headers: { authorization: 'Bearer runtime' },
            };
          },
        }) as unknown as AppHostingProvider,
        ensureAppRuntimeRunning: async () => {
          events.push('wake');
          return { ...loaded.runtime, status: 'running' };
        },
        enqueueCurrentAppRuntime: async () => {
          events.push('refresh');
          return true;
        },
        stampActivity: async () => {
          events.push('activity');
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.url).toBe('wss://runtime.example.test/base/socket?channel=events');
    expect(result.data.headers.authorization).toBe('Bearer runtime');
    expect(events).toEqual(['authorize', 'refresh', 'wake', 'activity', 'ingress']);
  });

  test('returns the retryable starting state when the runtime is not ready', async () => {
    const events: string[] = [];
    const result = await prepareAppWsUpgrade(
      new Request(REQUEST_URL),
      new URL(REQUEST_URL),
      dependencies({
        enqueueCurrentAppRuntime: async () => {
          events.push('refresh');
          return true;
        },
        ensureAppRuntimeRunning: async () => {
          events.push('wake');
          throw new Error('provider is resuming');
        },
      }),
    );

    expect(result).toEqual({ ok: false, status: 202, message: 'App is starting' });
    expect(events).toEqual(['refresh', 'wake']);
  });
});
