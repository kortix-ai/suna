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

function dependencies() {
  const builds: any[] = [];
  const creates: any[] = [];
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
    controlSecret: secret,
    fetch: fetch as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { hosting, builds, creates, ingressCalls, fetchCalls };
}

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
      provider: 'local-docker',
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
    const { hosting, creates } = dependencies();
    const result = await hosting.createRuntime({
      provider: 'daytona',
      runtimeId: 'runtime-1',
      accountId: 'account-1',
      userId: 'user-1',
      name: 'app-hello-v1',
      snapshotName: 'kortix-app-deployment-1',
      machine: { cpuCores: 1, memoryGb: 2, diskGb: 10 },
      autoStopMinutes: 5,
    });

    expect(creates[0]).toMatchObject({
      workloadType: 'app',
      snapshot: 'kortix-app-deployment-1',
      publishedPorts: [APP_CONTROL_PORT, APP_INGRESS_PORT],
      envVars: { KORTIX_APPD_TOKEN: appControlToken('runtime-1', secret) },
    });
    expect(creates[0].envVars.KORTIX_SANDBOX_TOKEN).toBeUndefined();
    expect(result.controlTokenHash).toBe(
      appControlTokenHash(appControlToken('runtime-1', secret)),
    );
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
});
