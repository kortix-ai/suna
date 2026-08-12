import { describe, expect, test } from 'bun:test';
import type { SandboxProvider } from '../platform/providers';
import type { SandboxProviderAdapter } from '../snapshots/providers';
import {
  APP_CONTROL_PORT,
  APP_INGRESS_PORT,
  AppHostingProvider,
  appControlToken,
  appControlTokenHash,
} from './hosting';

const secret = 'test-secret-at-least-sixteen-characters';

function dependencies(controlSecret: string = secret) {
  const builds: any[] = [];
  const creates: any[] = [];
  const appRuntimeStarts: string[] = [];
  const ingressCalls: any[] = [];
  const fetchCalls: any[] = [];
  const snapshot = {
    buildSnapshot: async (...args: any[]) => { builds.push(args); },
  } as unknown as SandboxProviderAdapter;
  const runtime = {
    create: async (input: any) => {
      creates.push(input);
      return { externalId: 'box-1', baseUrl: 'https://api.test/v1/p/box-1/8080', metadata: {} };
    },
    resolveIngress: async (externalId: string, request: any) => {
      ingressCalls.push({ externalId, request });
      return {
        url: `https://${request.port}-box.test`,
        headers: { 'x-provider-auth': 'provider-token' },
        effectivePort: request.port,
      };
    },
    start: async () => {},
    ensureRunning: async () => {},
    getStatus: async () => 'running',
    ensureAppRuntimeStarted: async (externalId: string) => { appRuntimeStarts.push(externalId); },
    stop: async () => {},
    remove: async () => {},
  } as unknown as SandboxProvider;
  const responses = [
    { status: 'starting', ready: false },
    { status: 'running', ready: true },
  ];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return Response.json(responses.shift() ?? { status: 'running', ready: true });
  };
  const hosting = new AppHostingProvider({
    snapshotProvider: () => snapshot,
    runtimeProvider: () => runtime,
    controlSecret,
    fetch: fetch as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { hosting, builds, creates, appRuntimeStarts, ingressCalls, fetchCalls };
}

describe('appControlToken', () => {
  // Prod ran a sub-16-character API_KEY_SECRET, so every App deployment died at
  // provisioning with "App control secret must contain at least 16 characters"
  // after a full image build. The secret is the scrypt salt for API-key hashes
  // and the HKDF root for project secrets, so it cannot be rotated to satisfy a
  // length floor. HKDF gives a fixed 32-byte key from any non-empty secret.
  test('derives a token from a secret shorter than 16 characters', () => {
    const token = appControlToken('runtime-1', 'short');
    expect(token).toBe(appControlToken('runtime-1', 'short'));
    expect(token).toHaveLength(43);
  });

  test('separates tokens by secret and by runtime id', () => {
    expect(appControlToken('runtime-1', 'short')).not.toBe(appControlToken('runtime-1', 'other'));
    expect(appControlToken('runtime-1', 'short')).not.toBe(appControlToken('runtime-2', 'short'));
    expect(appControlToken('runtime-1', secret)).not.toBe(appControlToken('runtime-1', 'short'));
  });

  test('rejects a missing runtime id or an empty secret', () => {
    expect(() => appControlToken('', secret)).toThrow('runtimeId is required');
    expect(() => appControlToken('runtime-1', '')).toThrow('App control secret is required');
  });

  // The prod failure surfaced at provisioning, not in the helper: the image had
  // already built and `createRuntime` threw while deriving the appd bearer.
  test('provisions an App runtime on a server whose secret is 5 characters', async () => {
    const { hosting, creates, appRuntimeStarts } = dependencies('short');
    const result = await hosting.createRuntime({
      provider: 'platinum',
      runtimeId: 'runtime-1',
      accountId: 'account-1',
      userId: 'user-1',
      name: 'app-bharat-ai-v1',
      snapshotName: 'kortix-app-deployment-1',
      machine: { cpuCores: 1, memoryGb: 2, diskGb: 10 },
    });

    expect(creates[0].envVars.KORTIX_APPD_TOKEN).toBe(appControlToken('runtime-1', 'short'));
    expect(result.controlTokenHash).toBe(
      appControlTokenHash(appControlToken('runtime-1', 'short')),
    );
    expect(appRuntimeStarts).toEqual(['box-1']);
  });

  // A control call must present the same bearer the runtime was created with,
  // or every status/log request against a short-secret server returns 401.
  test('signs control requests with the same short-secret bearer', async () => {
    const { hosting, fetchCalls } = dependencies('short');
    await hosting.status('platinum', 'box-1', 'runtime-1');
    expect(fetchCalls[0].init.headers.Authorization).toBe(
      `Bearer ${appControlToken('runtime-1', 'short')}`,
    );
  });
});

describe('AppHostingProvider', () => {
  test('derives a stable non-reversible control token hash', () => {
    const first = appControlToken('runtime-1', secret);
    expect(first).toBe(appControlToken('runtime-1', secret));
    expect(first).not.toBe(appControlToken('runtime-2', secret));
    expect(appControlTokenHash(first)).toHaveLength(64);
    expect(appControlTokenHash(first)).not.toContain(first);
  });

  test('builds the provider snapshot with the App runtime profile', async () => {
    const { hosting, builds } = dependencies();
    await hosting.buildImage({
      provider: 'daytona',
      snapshotName: 'kortix-app-deployment-1',
      slug: 'hello',
      sourceDir: '/tmp/source',
      dockerfile: 'FROM nginx:alpine',
      runtimeSpec: { static_root: '/usr/share/nginx/html' },
      machine: { cpuCores: 1, memoryGb: 2, diskGb: 10 },
    });

    expect(builds[0]![0]).toMatchObject({
      snapshotName: 'kortix-app-deployment-1',
      userDockerfile: 'FROM nginx:alpine',
      runtimeProfile: 'app',
      appContext: {
        sourceDir: '/tmp/source',
        runtimeSpec: { static_root: '/usr/share/nginx/html' },
      },
      spec: { cpu: 1, memoryGb: 2, diskGb: 10 },
    });
  });

  test('creates an App workload with only the derived appd token', async () => {
    const { hosting, creates, appRuntimeStarts } = dependencies();
    const result = await hosting.createRuntime({
      provider: 'daytona',
      runtimeId: 'runtime-1',
      accountId: 'account-1',
      userId: 'user-1',
      name: 'app-hello-v1',
      snapshotName: 'kortix-app-deployment-1',
      machine: { cpuCores: 1, memoryGb: 2, diskGb: 10 },
      // An obsolete caller must not be able to shrink the provider safety
      // backstop below the control-plane idle deadline.
      autoStopMinutes: 5,
    } as any);

    expect(creates[0]).toMatchObject({
      workloadType: 'app',
      snapshot: 'kortix-app-deployment-1',
      publishedPorts: [APP_CONTROL_PORT, APP_INGRESS_PORT],
      envVars: { KORTIX_APPD_TOKEN: appControlToken('runtime-1', secret) },
    });
    expect(creates[0].autoStopInterval).toBeUndefined();
    expect(creates[0].envVars.KORTIX_SANDBOX_TOKEN).toBeUndefined();
    expect(result.controlTokenHash).toBe(
      appControlTokenHash(appControlToken('runtime-1', secret)),
    );
    expect(appRuntimeStarts).toEqual(['box-1']);
  });

  test('restarts the App runtime daemon after provider start and cold wake', async () => {
    const { hosting, appRuntimeStarts } = dependencies();

    await hosting.start('daytona', 'box-1');
    await hosting.ensureRunning('daytona', 'box-1');

    expect(appRuntimeStarts).toEqual(['box-1', 'box-1']);
  });

  test('treats a provider start conflict as success when the runtime is already running', async () => {
    const events: string[] = [];
    const runtime = {
      start: async () => {
        events.push('start');
        throw new Error('Sandbox is already started');
      },
      getStatus: async () => {
        events.push('status');
        return 'running' as const;
      },
      ensureAppRuntimeStarted: async () => { events.push('appd'); },
    } as unknown as SandboxProvider;
    const hosting = new AppHostingProvider({ runtimeProvider: () => runtime });

    await hosting.start('daytona', 'box-1');

    expect(events).toEqual(['start', 'status', 'status', 'appd']);
  });

  test('waits for provider running state before starting appd after a cold wake', async () => {
    const events: string[] = [];
    const statuses = ['stopped', 'unknown', 'running'] as const;
    let statusIndex = 0;
    const runtime = {
      ensureRunning: async () => { events.push('wake'); },
      getStatus: async () => {
        const providerStatus = statuses[Math.min(statusIndex, statuses.length - 1)]!;
        statusIndex += 1;
        events.push(`status:${providerStatus}`);
        return providerStatus;
      },
      ensureAppRuntimeStarted: async () => { events.push('appd'); },
    } as unknown as SandboxProvider;
    const hosting = new AppHostingProvider({
      runtimeProvider: () => runtime,
      sleep: async () => {},
    });

    await hosting.ensureRunning('platinum', 'box-1');

    expect(events).toEqual(['wake', 'status:stopped', 'status:unknown', 'status:running', 'appd']);
  });

  test('treats an already stopped provider runtime as an idempotent stop', async () => {
    const events: string[] = [];
    const runtime = {
      stop: async () => {
        events.push('stop');
        throw new Error('Sandbox is not in a stoppable state');
      },
      getStatus: async () => {
        events.push('status');
        return 'stopped' as const;
      },
    } as unknown as SandboxProvider;
    const hosting = new AppHostingProvider({ runtimeProvider: () => runtime });

    await hosting.stop('daytona', 'box-1');

    expect(events).toEqual(['stop', 'status']);
  });

  test('preserves a stop error while the provider still reports running', async () => {
    const runtime = {
      stop: async () => {
        throw new Error('provider stop failed');
      },
      getStatus: async () => 'running' as const,
    } as unknown as SandboxProvider;
    const hosting = new AppHostingProvider({ runtimeProvider: () => runtime });

    expect(hosting.stop('platinum', 'box-1')).rejects.toThrow('provider stop failed');
  });

  test('polls authenticated appd status until the runtime is ready', async () => {
    const { hosting, ingressCalls, fetchCalls } = dependencies();
    const status = await hosting.waitUntilReady('e2b', 'box-1', 'runtime-1', 1_000);

    expect(status).toEqual({ status: 'running', ready: true });
    expect(ingressCalls).toHaveLength(2);
    expect(ingressCalls[0].request.port).toBe(APP_CONTROL_PORT);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'x-provider-auth': 'provider-token',
      Authorization: `Bearer ${appControlToken('runtime-1', secret)}`,
    });
  });

  test('restarts appd when the provider is running but the control endpoint is unavailable', async () => {
    const events: string[] = [];
    const runtime = {
      resolveIngress: async () => ({ url: 'https://control.test', headers: {}, effectivePort: 7331 }),
      ensureAppRuntimeStarted: async () => { events.push('bootstrap'); },
    } as unknown as SandboxProvider;
    const responses = [
      new Response('upstream unreachable', { status: 502 }),
      Response.json({ status: 'running', ready: true }),
    ];
    const hosting = new AppHostingProvider({
      runtimeProvider: () => runtime,
      controlSecret: secret,
      fetch: (async () => responses.shift()!) as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });

    await hosting.waitUntilReady('daytona', 'box-1', 'runtime-1', 1_000);

    expect(events).toEqual(['bootstrap']);
  });
});
