// Full provider-contract coverage for the EXPERIMENTAL local-docker provider,
// against a mocked dockerode client — mirrors the shape of daytona.test.ts /
// e2b.test.ts (real config, real provider class, fake transport).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'local-docker';
process.env.KORTIX_URL = 'https://api.example.com';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.LOCAL_DOCKER_NETWORK = 'kortix-local-docker-test';
process.env.PORT = '8008';
delete process.env.LOCAL_DOCKER_API_HOST;
delete process.env.LOCAL_DOCKER_API_PORT;
// Deterministic LLM-gateway base-url formula regardless of ambient .env —
// see the KORTIX_LLM_BASE_URL tests below.
delete process.env.LLM_GATEWAY_BASE_URL;
delete process.env.LLM_GATEWAY_PROXY_PORT;
delete process.env.LLM_GATEWAY_PROXY_TARGET;

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => 'service-key-test',
}));

interface FakeContainerRecord {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  running: boolean;
  createdEpochSeconds: number;
  hostPort: number;
}

function dockerError(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

class FakeDocker {
  containers = new Map<string, FakeContainerRecord>();
  networks = new Set<string>();
  pingOk = true;
  nextId = 0;
  createContainerCalls: Array<Record<string, unknown>> = [];
  createContainerError: Error | null = null;

  async ping() {
    if (!this.pingOk) throw new Error('connect ECONNREFUSED /var/run/docker.sock');
    return true;
  }

  getNetwork(name: string) {
    return {
      inspect: async () => {
        if (!this.networks.has(name)) throw dockerError(404, 'network not found');
        return { Name: name };
      },
    };
  }

  async createNetwork(opts: { Name: string }) {
    this.networks.add(opts.Name);
    return { id: opts.Name };
  }

  async createContainer(opts: Record<string, unknown>) {
    this.createContainerCalls.push(opts);
    if (this.createContainerError) throw this.createContainerError;
    const name = opts.name as string;
    if (this.containers.has(name)) {
      throw dockerError(409, `Conflict. The container name "/${name}" is already in use`);
    }
    const id = `cid-${++this.nextId}`;
    this.containers.set(name, {
      id,
      name,
      image: opts.Image as string,
      labels: (opts.Labels as Record<string, string>) ?? {},
      running: false,
      createdEpochSeconds: 1_700_000_000 + this.nextId,
      hostPort: 32000 + this.nextId,
    });
    return this.containerHandle(name);
  }

  getContainer(name: string) {
    return this.containerHandle(name);
  }

  private containerHandle(name: string) {
    const docker = this;
    return {
      get id() {
        return docker.containers.get(name)?.id ?? '';
      },
      async start() {
        const c = docker.containers.get(name);
        if (!c) throw dockerError(404, 'no such container');
        if (c.running) throw dockerError(304, 'container already started');
        c.running = true;
      },
      async stop() {
        const c = docker.containers.get(name);
        if (!c) throw dockerError(404, 'no such container');
        if (!c.running) throw dockerError(304, 'container already stopped');
        c.running = false;
      },
      async remove() {
        if (!docker.containers.has(name)) throw dockerError(404, 'no such container');
        docker.containers.delete(name);
      },
      async inspect() {
        const c = docker.containers.get(name);
        if (!c) throw dockerError(404, 'no such container');
        return {
          Id: c.id,
          Created: new Date(c.createdEpochSeconds * 1000).toISOString(),
          State: { Running: c.running, Status: c.running ? 'running' : 'exited' },
          Config: { Image: c.image },
          NetworkSettings: {
            Ports: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(c.hostPort) }] },
          },
        };
      },
    };
  }

  async listContainers(opts: { filters?: string }) {
    const filters = opts.filters ? JSON.parse(opts.filters) : {};
    const wantedLabels: string[] = filters.label ?? [];
    const out: Array<Record<string, unknown>> = [];
    for (const c of this.containers.values()) {
      if (!c.running) continue;
      const matches = wantedLabels.every((kv) => {
        const [k, v] = kv.split('=');
        return c.labels[k] === v;
      });
      if (!matches) continue;
      out.push({
        Id: c.id,
        Names: [`/${c.name}`],
        Labels: c.labels,
        Created: c.createdEpochSeconds,
      });
    }
    return out;
  }
}

const { config } = await import('../../config');
const { LocalDockerProvider, __setDockerClientForTest } = await import('./local-docker');
const { getProvider } = await import('./index');

let fakeDocker: FakeDocker;

beforeEach(() => {
  fakeDocker = new FakeDocker();
  __setDockerClientForTest(fakeDocker);
});

function baseCreateOpts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accountId: 'acct-1',
    userId: 'user-1',
    name: 'session-abcd1234',
    snapshot: 'kortix-default-abc123',
    envVars: { KORTIX_SANDBOX_TOKEN: 'sb-token-1' },
    ...overrides,
  } as any;
}

describe('local-docker provider — registry admission', () => {
  test('ALLOWED_SANDBOX_PROVIDERS=local-docker admits it with no API key', () => {
    expect(config.ALLOWED_SANDBOX_PROVIDERS).toEqual(['local-docker']);
    expect(config.isProviderEnabled('local-docker')).toBe(true);
    const provider = getProvider('local-docker');
    expect(provider.name).toBe('local-docker');
    expect(provider).toBeInstanceOf(LocalDockerProvider);
  });
});

describe('local-docker provider — create()', () => {
  test('runs a container named kortix-sb-<externalId> with the managed label scheme', async () => {
    const provider = new LocalDockerProvider();
    const result = await provider.create(baseCreateOpts());

    expect(result.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.baseUrl).toBe(`https://api.example.com/v1/p/${result.externalId}/8000`);

    const call = fakeDocker.createContainerCalls[0]!;
    expect(call.name).toBe(`kortix-sb-${result.externalId}`);
    expect(call.Image).toBe('kortix-default-abc123');
    expect(call.Labels).toEqual({
      'kortix.managed': 'true',
      'kortix.env': 'dev',
      'kortix.sandbox': result.externalId,
    });
    const hostConfig = call.HostConfig as Record<string, unknown>;
    expect(hostConfig.NetworkMode).toBe('kortix-local-docker-test');

    // Container was actually started (persistence semantics start at 'running').
    const status = await provider.getStatus(result.externalId);
    expect(status).toBe('running');
  });

  test('injects the standard sandbox env vars (KORTIX_API_URL, KORTIX_FRONTEND_URL, token)', async () => {
    const provider = new LocalDockerProvider();
    await provider.create(baseCreateOpts({ envVars: { KORTIX_SANDBOX_TOKEN: 'tok', KORTIX_CLI_TOKEN: 'cli-tok' } }));
    const env = fakeDocker.createContainerCalls[0]!.Env as string[];
    const asMap = Object.fromEntries(env.map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    }));
    expect(asMap.KORTIX_API_URL).toBe('http://kortix-api:8008/v1');
    expect(asMap.KORTIX_FRONTEND_URL).toBe('https://app.example.com');
    expect(asMap.KORTIX_SANDBOX_TOKEN).toBe('tok');
    expect(asMap.KORTIX_CLI_TOKEN).toBe('cli-tok');
  });

  // Regression: buildSessionRuntimeEnv() (projects/lib/session-runtime-env.ts)
  // unconditionally sets KORTIX_API_URL/KORTIX_FRONTEND_URL from the generic
  // public config.KORTIX_URL for EVERY provider — the right value for a
  // remote cloud sandbox, but WRONG for local-docker, whose container must
  // reach kortix-api by Docker network DNS name instead. Caught live: a
  // session's sandbox couldn't reach the control plane at all because the
  // generic value silently clobbered the provider's own Docker-DNS URL.
  test('KORTIX_API_URL / KORTIX_FRONTEND_URL from this file always win over whatever opts.envVars sets', async () => {
    const provider = new LocalDockerProvider();
    await provider.create(baseCreateOpts({
      envVars: {
        KORTIX_SANDBOX_TOKEN: 'tok',
        KORTIX_API_URL: 'https://api.example.com/v1', // the generic (public) value a real caller injects
        KORTIX_FRONTEND_URL: 'https://api.example.com', // ditto
      },
    }));
    const env = fakeDocker.createContainerCalls[0]!.Env as string[];
    const asMap = Object.fromEntries(env.map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    }));
    expect(asMap.KORTIX_API_URL).toBe('http://kortix-api:8008/v1');
    expect(asMap.KORTIX_FRONTEND_URL).toBe('https://app.example.com');
  });

  // Regression (live, self-host "ldocker" instance): the same generic-vs-
  // Docker-network gap as the KORTIX_API_URL bug above, but for OpenCode's own
  // LLM-gateway base URL. session-sandbox.ts computes KORTIX_LLM_BASE_URL from
  // the generic public origin (config.KORTIX_URL /
  // provider.sandboxFacingApiOrigin() when available) BEFORE calling
  // provider.create() — so opts.envVars.KORTIX_LLM_BASE_URL can still arrive
  // here already-correct. This asserts local-docker's create() rebuilds it
  // onto the Docker-network origin regardless, matching KORTIX_API_URL's
  // belt-and-suspenders override above. Caught live: OpenCode inside the
  // sandbox looped "Cannot connect to API" because KORTIX_LLM_BASE_URL fell
  // back to `http://localhost:8777/v1/llm` — unreachable from inside the
  // container (that's the CONTAINER's own loopback, not the host's).
  test('KORTIX_LLM_BASE_URL is rewritten onto the Docker-network origin when present', async () => {
    const provider = new LocalDockerProvider();
    await provider.create(baseCreateOpts({
      envVars: {
        KORTIX_SANDBOX_TOKEN: 'tok',
        KORTIX_LLM_API_KEY: 'gw-key',
        KORTIX_LLM_BASE_URL: 'https://api.example.com/v1/llm', // the generic (public) value a real caller injects
      },
    }));
    const env = fakeDocker.createContainerCalls[0]!.Env as string[];
    const asMap = Object.fromEntries(env.map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    }));
    expect(asMap.KORTIX_LLM_BASE_URL).toBe('http://kortix-api:8008/v1/llm');
    expect(asMap.KORTIX_LLM_API_KEY).toBe('gw-key'); // untouched — no URL inside it
  });

  test('leaves KORTIX_LLM_BASE_URL absent when the LLM gateway was not enabled for this session', async () => {
    const provider = new LocalDockerProvider();
    await provider.create(baseCreateOpts({ envVars: { KORTIX_SANDBOX_TOKEN: 'tok' } }));
    const env = fakeDocker.createContainerCalls[0]!.Env as string[];
    const asMap = Object.fromEntries(env.map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    }));
    expect(asMap.KORTIX_LLM_BASE_URL).toBeUndefined();
  });

  test('sandboxFacingApiOrigin() reports the Docker-network origin (used by session-sandbox.ts and sandbox-env-sync.ts)', () => {
    const provider = new LocalDockerProvider();
    expect(provider.sandboxFacingApiOrigin?.()).toBe('http://kortix-api:8008');
  });

  test('auto-creates the configured Docker network if missing', async () => {
    expect(fakeDocker.networks.has('kortix-local-docker-test')).toBe(false);
    const provider = new LocalDockerProvider();
    await provider.create(baseCreateOpts());
    expect(fakeDocker.networks.has('kortix-local-docker-test')).toBe(true);
  });

  test('applies a resource ceiling (--cpus / --memory equivalent) to every container', async () => {
    const provider = new LocalDockerProvider();
    await provider.create(baseCreateOpts());
    const hostConfig = fakeDocker.createContainerCalls[0]!.HostConfig as Record<string, unknown>;
    expect(typeof hostConfig.NanoCpus).toBe('number');
    expect(hostConfig.NanoCpus).toBeGreaterThan(0);
    expect(typeof hostConfig.Memory).toBe('number');
    expect(hostConfig.Memory).toBeGreaterThan(0);
  });

  test('throws a clear error when opts.snapshot is missing (no shared fallback image, matches Daytona)', async () => {
    const provider = new LocalDockerProvider();
    await expect(provider.create(baseCreateOpts({ snapshot: undefined }))).rejects.toThrow(/opts\.snapshot/);
  });

  test('throws when KORTIX_SANDBOX_TOKEN is missing', async () => {
    const provider = new LocalDockerProvider();
    await expect(provider.create(baseCreateOpts({ envVars: {} }))).rejects.toThrow(/KORTIX_SANDBOX_TOKEN/);
  });

  test('throws a clear, actionable error when the Docker socket is unreachable', async () => {
    fakeDocker.pingOk = false;
    const provider = new LocalDockerProvider();
    await expect(provider.create(baseCreateOpts())).rejects.toThrow(/Docker daemon is not reachable/);
  });

  test('propagates a missing-image error from the daemon (error path: image not built yet)', async () => {
    fakeDocker.createContainerError = dockerError(404, 'No such image: kortix-tpl-doesnotexist:latest');
    const provider = new LocalDockerProvider();
    await expect(provider.create(baseCreateOpts({ snapshot: 'kortix-tpl-doesnotexist' })))
      .rejects.toThrow(/No such image/);
  });

  test('propagates a container-name conflict from the daemon (error path: name already in use)', async () => {
    // externalId is a fresh randomUUID per create(), so a real collision never
    // happens in practice — this exercises that create() propagates the
    // daemon's 409 unmodified rather than swallowing or misreporting it,
    // exactly like the missing-image case above.
    fakeDocker.createContainerError = dockerError(409, 'Conflict. The container name "/kortix-sb-x" is already in use');
    const provider = new LocalDockerProvider();
    await expect(provider.create(baseCreateOpts())).rejects.toThrow(/already in use/);
  });
});

describe('local-docker provider — lifecycle (start/stop/remove/getStatus)', () => {
  test('stop() preserves the container (persistence semantics) — status is stopped, not removed', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    await provider.stop(externalId);
    expect(await provider.getStatus(externalId)).toBe('stopped');
    expect(fakeDocker.containers.has(`kortix-sb-${externalId}`)).toBe(true);
  });

  test('start() resumes a stopped container', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    await provider.stop(externalId);
    await provider.start(externalId);
    expect(await provider.getStatus(externalId)).toBe('running');
  });

  test('start()/stop() are idempotent against an already-started/-stopped container (304)', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    // Already running — start() again must not throw.
    await expect(provider.start(externalId)).resolves.toBeUndefined();
    await provider.stop(externalId);
    // Already stopped — stop() again must not throw.
    await expect(provider.stop(externalId)).resolves.toBeUndefined();
  });

  test('remove() deletes the container; getStatus() then reports removed', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    await provider.remove(externalId);
    expect(await provider.getStatus(externalId)).toBe('removed');
    expect(fakeDocker.containers.has(`kortix-sb-${externalId}`)).toBe(false);
  });

  test('remove() on an already-missing container is a no-op, not an error', async () => {
    const provider = new LocalDockerProvider();
    await expect(provider.remove('never-existed')).resolves.toBeUndefined();
  });

  test('getStatus() reports removed for a container that vanished externally (e.g. manual `docker rm`)', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    fakeDocker.containers.delete(`kortix-sb-${externalId}`); // simulate external removal
    expect(await provider.getStatus(externalId)).toBe('removed');
  });

  test('getStatus() reports unknown (never throws) when the Docker socket is down', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    fakeDocker.pingOk = false;
    expect(await provider.getStatus(externalId)).toBe('unknown');
  });

  test('ensureRunning() starts a stopped sandbox and no-ops a running one', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    await provider.ensureRunning(externalId); // already running — no-op
    expect(await provider.getStatus(externalId)).toBe('running');
    await provider.stop(externalId);
    await provider.ensureRunning(externalId); // stopped — should start
    expect(await provider.getStatus(externalId)).toBe('running');
  });

  test('ensureRunning() does not attempt to recover a removed sandbox (fails closed)', async () => {
    const provider = new LocalDockerProvider();
    await provider.ensureRunning('never-existed'); // must not throw
    expect(await provider.getStatus('never-existed')).toBe('removed');
  });
});

describe('local-docker provider — ingress / endpoint resolution', () => {
  test('resolveIngress() addresses the container by network DNS name, any port, no pre-registration', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    const ingress = await provider.resolveIngress(externalId, { port: 3000 });
    expect(ingress.url).toBe(`http://kortix-sb-${externalId}:3000`);
    expect(ingress.effectivePort).toBe(3000);
  });

  test('resolveEndpoint() targets the agent port and injects the sandbox service key as a bearer', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create(baseCreateOpts());
    const endpoint = await provider.resolveEndpoint(externalId);
    expect(endpoint.url).toBe(`http://kortix-sb-${externalId}:8000`);
    expect(endpoint.headers.Authorization).toBe('Bearer service-key-test');
    expect(endpoint.headers['Content-Type']).toBe('application/json');
  });

  test('routeIngress() is the identity mapping', () => {
    const provider = new LocalDockerProvider();
    expect(provider.routeIngress({ port: 4096 })).toEqual({ effectivePort: 4096 });
  });
});

describe('local-docker provider — listManagedRunningSandboxes (reaper scoping)', () => {
  test('lists only running, this-environment-labeled containers, scoped like every other provider', async () => {
    const provider = new LocalDockerProvider();
    const a = await provider.create(baseCreateOpts({ name: 'sb-a' }));
    const b = await provider.create(baseCreateOpts({ name: 'sb-b' }));
    await provider.stop(b.externalId); // stopped boxes must not appear
    // A foreign-env container must be excluded even if running.
    fakeDocker.containers.set('kortix-sb-foreign', {
      id: 'cid-foreign',
      name: 'kortix-sb-foreign',
      image: 'x',
      labels: { 'kortix.managed': 'true', 'kortix.env': 'prod', 'kortix.sandbox': 'foreign' },
      running: true,
      createdEpochSeconds: 1_700_000_500,
      hostPort: 40000,
    });

    const listed = await provider.listManagedRunningSandboxes!();
    expect(listed.map((x) => x.externalId).sort()).toEqual([a.externalId].sort());
    expect(listed[0]!.createdAt).toBeInstanceOf(Date);
  });
});
