import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'e2b';
process.env.E2B_API_KEY = 'e2b_test_key';
process.env.E2B_TEMPLATE = 'kortix-test';
process.env.KORTIX_URL = 'https://api.example.com';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.DATABASE_URL ??= 'postgres://x';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.FREESTYLE_API_URL = 'https://freestyle.test';
process.env.RECALL_BASE_URL = 'https://recall.test';
process.env.FRONTEND_URL = 'https://app.example.com';

type FakeSandbox = ReturnType<typeof fakeSandbox>;

let createdTemplate: string | undefined;
let createdOpts: Record<string, unknown> | undefined;
let connected: Array<{ sandboxId: string; opts: Record<string, unknown> }> = [];
let staticPauses: Array<{ sandboxId: string; opts: Record<string, unknown> }> = [];
let killed: string[] = [];
let infoState: 'running' | 'paused' | 'missing' = 'running';
let listed: Array<{ sandboxId: string; startedAt: Date | null }> = [];
let listOpts: Record<string, unknown> | undefined;
let connectFactory: (sandboxId: string) => FakeSandbox = (sandboxId) => fakeSandbox(sandboxId);
let createFactory: () => FakeSandbox = () => fakeSandbox('sb-created');

class FakeSandboxNotFoundError extends Error {}

function fakeSandbox(sandboxId: string, trafficAccessToken = `traffic-${sandboxId}`) {
  const pauses: Array<Record<string, unknown>> = [];
  const runs: Array<{ command: string; opts: Record<string, unknown> }> = [];
  const fileWrites: Array<{ path: string; data: string; opts: Record<string, unknown> }> = [];
  const files = new Map<string, string>([
    ['/etc/kortix/runtime-env.json', JSON.stringify({ KORTIX_SANDBOX_TOKEN: 'persisted-token' })],
  ]);
  const sandbox = {
    sandboxId,
    trafficAccessToken,
    pauses,
    runs,
    fileWrites,
    persistedFiles: files,
    files: {
      write: async (path: string, data: string, opts: Record<string, unknown>) => {
        fileWrites.push({ path, data, opts });
        files.set(path, data);
        return { path };
      },
      read: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing file: ${path}`);
        return value;
      },
    },
    commands: {
      list: async () => [],
      run: async (command: string, opts: Record<string, unknown>) => {
        runs.push({ command, opts });
        return { exitCode: 0 };
      },
    },
    pause: async (opts: Record<string, unknown>) => {
      pauses.push(opts);
      return true;
    },
    kill: async () => {
      killed.push(sandboxId);
      return true;
    },
    getHost: (port: number) => `${port}-${sandboxId}.e2b.test`,
  };
  return sandbox;
}

class FakeSandboxApi {
  static async create(template: string, opts: Record<string, unknown>) {
    createdTemplate = template;
    createdOpts = opts;
    return createFactory();
  }

  static async connect(sandboxId: string, opts: Record<string, unknown>) {
    connected.push({ sandboxId, opts });
    return connectFactory(sandboxId);
  }

  static async pause(sandboxId: string, opts: Record<string, unknown>) {
    staticPauses.push({ sandboxId, opts });
    return true;
  }

  static async kill(sandboxId: string) {
    killed.push(sandboxId);
    return true;
  }

  static async getInfo() {
    if (infoState === 'missing') throw new FakeSandboxNotFoundError('sandbox not found');
    return { state: infoState };
  }

  static list(opts: Record<string, unknown>) {
    listOpts = opts;
    let hasNext = true;
    return {
      get hasNext() {
        return hasNext;
      },
      nextItems: async () => {
        hasNext = false;
        return listed;
      },
    };
  }
}

mock.module('e2b', () => ({
  Sandbox: FakeSandboxApi,
  SandboxNotFoundError: FakeSandboxNotFoundError,
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => 'service-key-test',
}));

const { config } = await import('../../config');
const { E2BProvider } = await import('./e2b');
const { getProvider } = await import('./index');

beforeEach(() => {
  createdTemplate = undefined;
  createdOpts = undefined;
  connected = [];
  staticPauses = [];
  killed = [];
  infoState = 'running';
  listed = [];
  listOpts = undefined;
  connectFactory = (sandboxId) => fakeSandbox(sandboxId);
  createFactory = () => fakeSandbox('sb-created');
});

describe('E2B provider admission and registry', () => {
  test('ALLOWED_SANDBOX_PROVIDERS=e2b admits E2B as a configured provider', () => {
    expect(config.ALLOWED_SANDBOX_PROVIDERS).toEqual(['e2b']);
    expect(config.isProviderEnabled('e2b')).toBe(true);
    expect(config.getDefaultProvider()).toBe('e2b');
  });

  test('the runtime registry resolves E2B through the shared interface', () => {
    expect(getProvider('e2b').name).toBe('e2b');
  });
});

describe('E2B provider lifecycle', () => {
  test('create is private, filesystem-persistent, explicit-resume-only, and launches Kortix', async () => {
    const sandbox = fakeSandbox('sb-secure', 'traffic-secret');
    createFactory = () => sandbox;
    const provider = new E2BProvider();

    const result = await provider.create({
      accountId: 'acc-1',
      userId: 'usr-1',
      name: 'session-1',
      snapshot: 'kortix-template-1',
      envVars: { KORTIX_SANDBOX_TOKEN: 'sandbox-token' },
    });

    expect(createdTemplate).toBe('kortix-template-1');
    expect(createdOpts).toMatchObject({
      timeoutMs: 3_600_000,
      secure: true,
      allowInternetAccess: true,
      network: { allowPublicTraffic: false },
      lifecycle: {
        onTimeout: { action: 'pause', keepMemory: false },
        autoResume: false,
      },
      metadata: {
        kortix_managed: 'true',
        kortix_env: 'dev',
        kortix_account_id: 'acc-1',
        kortix_created_by: 'usr-1',
      },
    });
    expect(sandbox.fileWrites).toHaveLength(1);
    expect(sandbox.fileWrites[0]).toMatchObject({
      path: '/etc/kortix/runtime-env.json',
      opts: { user: 'root' },
    });
    expect(JSON.parse(sandbox.fileWrites[0].data)).toMatchObject({
      KORTIX_SANDBOX_TOKEN: 'sandbox-token',
      KORTIX_API_URL: 'https://api.example.com/v1',
    });
    expect(sandbox.runs).toHaveLength(3);
    expect(sandbox.runs[0].command).toBe('chmod 600 /etc/kortix/runtime-env.json');
    expect(sandbox.runs[1]).toMatchObject({
      command: '/usr/local/bin/kortix-entrypoint',
      opts: { envs: expect.objectContaining({ KORTIX_SANDBOX_TOKEN: 'sandbox-token' }) },
    });
    expect(sandbox.runs[2].command).toContain('http://127.0.0.1:8000/kortix/health');
    expect(result).toMatchObject({
      externalId: 'sb-secure',
      metadata: { lifecycle: 'pause-filesystem-explicit-resume' },
    });
  });

  test('private sandbox creation fails closed when E2B omits the traffic token', async () => {
    createFactory = () => fakeSandbox('sb-tokenless', '');
    const provider = new E2BProvider();

    await expect(provider.create({
      accountId: 'acc-1',
      userId: 'usr-1',
      name: 'session-1',
      snapshot: 'tpl',
      envVars: { KORTIX_SANDBOX_TOKEN: 'sandbox-token' },
    })).rejects.toThrow('private traffic access token');

    expect(killed).toEqual(['sb-tokenless']);
  });

  test('stop drops RAM but preserves disk, and start explicitly reconnects the same identity', async () => {
    const sandbox = fakeSandbox('sb-lifecycle');
    createFactory = () => sandbox;
    const provider = new E2BProvider();
    await provider.create({
      accountId: 'acc-1', userId: 'usr-1', name: 'session-1', snapshot: 'tpl',
      envVars: { KORTIX_SANDBOX_TOKEN: 'sandbox-token' },
    });

    await provider.stop('sb-lifecycle');
    expect(sandbox.pauses).toEqual([
      expect.objectContaining({ apiKey: 'e2b_test_key', keepMemory: false }),
    ]);

    await provider.start('sb-lifecycle');
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({ sandboxId: 'sb-lifecycle' });
  });

  test('cold resume verifies the Kortix entrypoint on the same sandbox identity', async () => {
    const resumed = fakeSandbox('sb-cold-resume');
    connectFactory = () => resumed;
    const provider = new E2BProvider();

    await provider.start('sb-cold-resume');

    expect(connected.map((call) => call.sandboxId)).toEqual(['sb-cold-resume']);
    expect(resumed.runs).toEqual([
      expect.objectContaining({
        command: '/usr/local/bin/kortix-entrypoint',
        opts: expect.objectContaining({
          envs: expect.objectContaining({ KORTIX_SANDBOX_TOKEN: 'persisted-token' }),
        }),
      }),
      expect.objectContaining({
        command: expect.stringContaining('http://127.0.0.1:8000/kortix/health'),
      }),
    ]);
  });

  test.each([
    ['missing', undefined, 'missing file'],
    ['malformed', '{not-json', 'JSON'],
    ['non-string', JSON.stringify({ KORTIX_SANDBOX_TOKEN: 42 }), 'non-string'],
    ['tokenless', JSON.stringify({ KORTIX_API_URL: 'https://api.example.com/v1' }), 'no KORTIX_SANDBOX_TOKEN'],
  ] as const)(
    'cold resume fails closed for a %s persisted runtime environment',
    async (_case, persisted, expectedMessage) => {
      const resumed = fakeSandbox(`sb-cold-${_case}`);
      if (persisted === undefined) resumed.persistedFiles.delete('/etc/kortix/runtime-env.json');
      else resumed.persistedFiles.set('/etc/kortix/runtime-env.json', persisted);
      connectFactory = () => resumed;
      const provider = new E2BProvider();

      await expect(provider.start(resumed.sandboxId)).rejects.toThrow(expectedMessage);
      expect(resumed.runs).toHaveLength(0);
    },
  );

  test('a process restart can pause by ID without first resuming the sandbox', async () => {
    const provider = new E2BProvider();
    await provider.stop('sb-uncached');
    expect(staticPauses).toEqual([
      { sandboxId: 'sb-uncached', opts: expect.objectContaining({ keepMemory: false }) },
    ]);
    expect(connected).toHaveLength(0);
  });

  test('ingress reconnects explicitly and forwards the private traffic token', async () => {
    connectFactory = (sandboxId) => fakeSandbox(sandboxId, 'traffic-private');
    const provider = new E2BProvider();

    const ingress = await provider.resolveIngress('sb-ingress', { port: 3000, transport: 'websocket' });

    expect(connected.map((call) => call.sandboxId)).toEqual(['sb-ingress']);
    expect(ingress).toEqual({
      url: 'https://3000-sb-ingress.e2b.test',
      headers: { 'e2b-traffic-access-token': 'traffic-private' },
      effectivePort: 3000,
    });
  });

  test('ingress fails closed rather than exposing a tokenless private URL', async () => {
    connectFactory = (sandboxId) => fakeSandbox(sandboxId, '');
    const provider = new E2BProvider();

    await expect(
      provider.resolveIngress('sb-tokenless-ingress', { port: 3000, transport: 'http' }),
    ).rejects.toThrow('private traffic access token');
  });

  test('missing provider identity is terminal and permanent removal is idempotent', async () => {
    const provider = new E2BProvider();
    infoState = 'missing';
    expect(await provider.getStatus('sb-missing')).toBe('removed');
    await provider.remove('sb-remove');
    expect(killed).toEqual(['sb-remove']);
  });

  test('the orphan reaper list is scoped to Kortix and the current environment', async () => {
    listed = [
      { sandboxId: 'sb-1', startedAt: new Date('2026-07-13T12:00:00Z') },
      { sandboxId: 'sb-2', startedAt: null },
    ];
    const provider = new E2BProvider();

    expect(await provider.listManagedRunningSandboxes()).toEqual([
      { externalId: 'sb-1', createdAt: new Date('2026-07-13T12:00:00Z') },
      { externalId: 'sb-2', createdAt: null },
    ]);
    expect(listOpts).toMatchObject({
      query: {
        metadata: { kortix_managed: 'true', kortix_env: 'dev' },
        state: ['running'],
      },
    });
  });
});
