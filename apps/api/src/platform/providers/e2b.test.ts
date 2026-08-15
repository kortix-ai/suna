import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'e2b';
process.env.E2B_API_KEY = 'e2b_test_key';
process.env.E2B_TEMPLATE = 'kortix-test';
process.env.KORTIX_URL = 'https://api.example.com';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.DATABASE_URL ??= 'postgres://x';
process.env.SUPABASE_URL = 'http://supabase.test';
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
let connectFactory: (sandboxId: string) => FakeSandbox | Promise<FakeSandbox> = (sandboxId) => fakeSandbox(sandboxId);
let createFactory: () => FakeSandbox = () => fakeSandbox('sb-created');
let killFactory: (sandboxId: string) => boolean | Promise<boolean> = (sandboxId) => {
  killed.push(sandboxId);
  return true;
};

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
    return killFactory(sandboxId);
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
  killFactory = (sandboxId) => {
    killed.push(sandboxId);
    return true;
  };
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
      command: expect.stringContaining('flock -n /run/kortix-entrypoint.lock /usr/local/bin/kortix-entrypoint'),
      opts: {
        background: true,
        timeoutMs: 0,
        envs: expect.objectContaining({ KORTIX_SANDBOX_TOKEN: 'sandbox-token' }),
      },
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

  test('App creation persists appd auth and launches only the App entrypoint', async () => {
    const sandbox = fakeSandbox('app-secure');
    createFactory = () => sandbox;
    const provider = new E2BProvider();

    const result = await provider.create({
      accountId: 'acc-1',
      userId: 'usr-1',
      name: 'app-1',
      snapshot: 'app-template-1',
      workloadType: 'app',
      envVars: { KORTIX_APPD_TOKEN: 'appd-token' },
      publishedPorts: [7331, 8080],
    });

    expect(result.baseUrl).toBe('https://api.example.com/v1/p/app-secure/8080');
    expect(createdOpts).toMatchObject({
      metadata: { kortix_workload: 'app' },
      envs: { KORTIX_WORKLOAD_TYPE: 'app', KORTIX_APPD_TOKEN: 'appd-token' },
    });
    expect(sandbox.runs.map((run) => run.command)).toEqual([
      'chmod 600 /etc/kortix/runtime-env.json',
      expect.stringContaining('/kortix/bin/kortix-appd'),
      expect.stringContaining('http://127.0.0.1:7331/v1/health'),
    ]);
    expect(sandbox.runs.map((run) => run.command).join('\n')).not.toContain(
      '/usr/local/bin/kortix-entrypoint',
    );
    expect(JSON.parse(sandbox.fileWrites[0]!.data)).toMatchObject({
      KORTIX_WORKLOAD_TYPE: 'app',
      KORTIX_APPD_TOKEN: 'appd-token',
    });
  });

  test('App cold resume relaunches appd and skips the session entrypoint', async () => {
    const resumed = fakeSandbox('app-resume');
    resumed.persistedFiles.set('/etc/kortix/runtime-env.json', JSON.stringify({
      KORTIX_WORKLOAD_TYPE: 'app',
      KORTIX_APPD_TOKEN: 'persisted-appd-token',
    }));
    connectFactory = () => resumed;

    await new E2BProvider().start('app-resume');

    expect(resumed.runs.map((run) => run.command)).toEqual([
      expect.stringContaining('/kortix/bin/kortix-appd'),
      expect.stringContaining('http://127.0.0.1:7331/v1/health'),
    ]);
    expect(resumed.runs.map((run) => run.command).join('\n')).not.toContain(
      '/usr/local/bin/kortix-entrypoint',
    );
  });

  test('ensureAppRuntimeStarted relaunches a dead appd instead of doing nothing', async () => {
    // This used to be a no-op, on the reasoning that E2B honors the image
    // ENTRYPOINT. The App template start command is overridden with
    // `sleep infinity`, so nothing restarted appd — and this is exactly the
    // call AppHostingProvider.waitUntilReady makes to recover a stalled App.
    const sandbox = fakeSandbox('app-recover');
    sandbox.persistedFiles.set('/etc/kortix/runtime-env.json', JSON.stringify({
      KORTIX_WORKLOAD_TYPE: 'app',
      KORTIX_APPD_TOKEN: 'persisted-appd-token',
    }));
    connectFactory = () => sandbox;

    await new E2BProvider().ensureAppRuntimeStarted('app-recover');

    expect(sandbox.runs.map((run) => run.command)).toEqual([
      expect.stringContaining('/kortix/bin/kortix-appd'),
      expect.stringContaining('http://127.0.0.1:7331/v1/health'),
    ]);
    // The relaunch carries the persisted appd credential, so the recovered
    // daemon answers the control port instead of 401ing the readiness poll.
    expect(sandbox.runs[0]!.opts).toMatchObject({
      envs: { KORTIX_APPD_TOKEN: 'persisted-appd-token' },
      user: 'root',
    });
  });

  test('ensureAppRuntimeStarted leaves a session sandbox alone', async () => {
    // The persisted default fixture is a SESSION runtime. Launching appd into
    // one would put a second supervisor in a box that never wanted it.
    const sandbox = fakeSandbox('session-box');
    connectFactory = () => sandbox;

    await new E2BProvider().ensureAppRuntimeStarted('session-box');

    expect(sandbox.runs).toEqual([]);
  });

  test('rejects an App workload without KORTIX_APPD_TOKEN', async () => {
    await expect(new E2BProvider().create({
      accountId: 'acc-1',
      userId: 'usr-1',
      name: 'app-1',
      snapshot: 'app-template-1',
      workloadType: 'app',
      envVars: { KORTIX_SANDBOX_TOKEN: 'session-token-is-not-valid-for-apps' },
    })).rejects.toThrow(/KORTIX_APPD_TOKEN/);
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
        command: expect.stringContaining('flock -n /run/kortix-entrypoint.lock /usr/local/bin/kortix-entrypoint'),
        opts: expect.objectContaining({
          background: true,
          timeoutMs: 0,
          envs: expect.objectContaining({ KORTIX_SANDBOX_TOKEN: 'persisted-token' }),
        }),
      }),
      expect.objectContaining({
        command: expect.stringContaining('http://127.0.0.1:8000/kortix/health'),
      }),
    ]);
  });

  test('overlapping cold-resume calls share one provider start operation', async () => {
    const resumed = fakeSandbox('sb-concurrent-resume');
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    connectFactory = async () => {
      await connectGate;
      return resumed;
    };
    const provider = new E2BProvider();

    const first = provider.start('sb-concurrent-resume');
    const second = provider.start('sb-concurrent-resume');
    await Promise.resolve();

    expect(connected.map((call) => call.sandboxId)).toEqual(['sb-concurrent-resume']);
    releaseConnect();
    await Promise.all([first, second]);
    expect(resumed.runs.filter((run) => run.command.includes('/usr/local/bin/kortix-entrypoint'))).toHaveLength(1);
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

    killFactory = () => {
      throw new FakeSandboxNotFoundError('sandbox not found');
    };
    await expect(provider.remove('sb-remove')).resolves.toBeUndefined();
  });

  test('permanent removal rejects within its outer timeout when the E2B SDK never settles', async () => {
    killFactory = () => new Promise<boolean>(() => {});
    const provider = new E2BProvider(25);

    const startedAt = performance.now();
    await expect(provider.remove('sb-hung')).rejects.toThrow(
      'E2B kill(sb-hung) timed out after 25ms',
    );
    expect(performance.now() - startedAt).toBeLessThan(500);
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
