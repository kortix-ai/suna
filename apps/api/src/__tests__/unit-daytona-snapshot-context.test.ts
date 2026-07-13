import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona');
setTestEnv('DAYTONA_API_KEY', 'test-daytona-key');
setTestEnv('DAYTONA_SERVER_URL', 'https://daytona.example.test');
setTestEnv('DAYTONA_TARGET', 'test-target');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'kortix-daytona-context-test-'));
const agentPath = join(fixtureRoot, 'kortix-agent');
const cliPath = join(fixtureRoot, 'kortix');
const entrypointPath = join(fixtureRoot, 'entrypoint.sh');
const slackCliPath = join(fixtureRoot, 'slack-cli');
const executorSdkPath = join(fixtureRoot, 'executor-sdk');
const opencodeConfigPath = join(fixtureRoot, 'opencode-config');

writeFileSync(agentPath, '#!/bin/sh\n');
writeFileSync(cliPath, '#!/bin/sh\n');
writeFileSync(entrypointPath, '#!/bin/sh\n');
await chmod(agentPath, 0o755);
await chmod(cliPath, 0o755);
await chmod(entrypointPath, 0o755);
await mkdir(slackCliPath, { recursive: true });
await mkdir(executorSdkPath, { recursive: true });
await mkdir(join(executorSdkPath, 'node_modules'), { recursive: true });
await symlink(
  '/definitely-not-present/typescript',
  join(executorSdkPath, 'node_modules', 'typescript'),
);
await mkdir(opencodeConfigPath, { recursive: true });

// Set per-test (NOT at module load): build-context reads these lazily, so setting
// them in beforeEach makes THIS suite's fixtures win during its own tests without
// leaking into sibling suites that override the same vars in a combined run.
beforeEach(() => {
  process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH = agentPath;
  process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH = cliPath;
  process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH = entrypointPath;
  process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH = slackCliPath;
  process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH = executorSdkPath;
  process.env.KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH = opencodeConfigPath;
  getSnapshotImpl = async () => ({ state: snapshotState() });
  deleteSnapshotImpl = async () => {};
});

let dockerfileSeen = '';
let scaffoldPresentAtDaytonaBoundary = false;
let executorNodeModulesPresentAtProviderBoundary = false;
// One push per build attempt — the composed Dockerfile path (== context dir).
// Each entry is a DISTINCT temp dir iff the adapter re-staged a fresh context.
const contextPaths: string[] = [];
// Per-test behavior (default: a clean successful build), driven by the tests.
let createImpl: () => Promise<void> = async () => {};
let snapshotState: () => string = () => 'active';
let getSnapshotImpl: () => Promise<{ state: string }> = async () => ({ state: snapshotState() });
let deleteSnapshotImpl: (snapshot: { state: string }) => Promise<void> = async () => {};

mock.module('@daytonaio/sdk', () => ({
  Image: {
    fromDockerfile(path: string) {
      dockerfileSeen = readFileSync(path, 'utf8');
      // Checked HERE (at the Daytona boundary, mid-build) — buildSnapshot's
      // finally cleans the context after, so this can't be asserted afterward.
      scaffoldPresentAtDaytonaBoundary = existsSync(join(path, '..', 'scaffold.git', 'HEAD'));
      executorNodeModulesPresentAtProviderBoundary = existsSync(
        join(path, '..', 'kortix-executor-sdk', 'node_modules'),
      );
      contextPaths.push(path);
      return { kind: 'mock-image', path };
    },
  },
}));

mock.module('../shared/daytona', () => ({
  getDaytona: () => ({
    snapshot: {
      create: async () => {
        await createImpl();
      },
      get: async () => getSnapshotImpl(),
      delete: async (snapshot: { state: string }) => deleteSnapshotImpl(snapshot),
    },
  }),
  isDaytonaConfigured: () => true,
  listDaytonaSnapshots: async () => [],
}));

const { daytonaProvider } = await import('../snapshots/providers/daytona');

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const buildInput = (name: string) =>
  ({ snapshotName: name, image: 'ubuntu:24.04', spec: {}, slug: 'default' }) as Parameters<
    typeof daytonaProvider.buildSnapshot
  >[0];

describe('Daytona snapshot build context', () => {
  test('stages every file referenced by the generated Dockerfile before calling Daytona', async () => {
    contextPaths.length = 0;
    createImpl = async () => {};
    snapshotState = () => 'active';

    await daytonaProvider.buildSnapshot(buildInput('kortix-test-context'));

    expect(dockerfileSeen).toContain('COPY scaffold.git /opt/kortix/scaffold.git');
    expect(scaffoldPresentAtDaytonaBoundary).toBe(true);
    expect(executorNodeModulesPresentAtProviderBoundary).toBe(false);
  });
});

describe('Daytona snapshot state', () => {
  test('reports a Daytona 404 as missing so a new template can be built', async () => {
    getSnapshotImpl = async () => {
      throw Object.assign(new Error('Snapshot with name kortix-new-template not found'), {
        name: 'DaytonaNotFoundError',
        statusCode: 404,
      });
    };

    expect(await daytonaProvider.getSnapshotState('kortix-new-template')).toBe('missing');
  });

  test('keeps a transient Daytona probe failure unknown', async () => {
    getSnapshotImpl = async () => {
      throw Object.assign(new Error('upstream unavailable'), {
        statusCode: 503,
      });
    };

    expect(await daytonaProvider.getSnapshotState('kortix-new-template')).toBe('unknown');
  });

  test('keeps a timed-out Daytona probe unknown', async () => {
    getSnapshotImpl = async () => {
      throw new Error('Daytona snapshot.get(kortix-timeout-template) timed out');
    };

    expect(await daytonaProvider.getSnapshotState('kortix-timeout-template')).toBe('unknown');
  });

  test('suppresses confirmed not-found delete errors and invalidates cached active state', async () => {
    let getCalls = 0;
    getSnapshotImpl = async () => {
      getCalls += 1;
      return { state: 'active' };
    };

    expect(await daytonaProvider.getSnapshotState('kortix-delete-missing')).toBe('active');

    deleteSnapshotImpl = async () => {
      throw Object.assign(new Error('Snapshot with name kortix-delete-missing not found'), {
        response: { status: 404 },
      });
    };

    await daytonaProvider.deleteSnapshot('kortix-delete-missing');

    getSnapshotImpl = async () => {
      getCalls += 1;
      throw Object.assign(new Error('Snapshot with name kortix-delete-missing not found'), {
        statusCode: 404,
      });
    };

    expect(await daytonaProvider.getSnapshotState('kortix-delete-missing')).toBe('missing');
    expect(getCalls).toBe(3);
  });

  test('propagates Daytona delete outages but still invalidates cached active state', async () => {
    let getCalls = 0;
    getSnapshotImpl = async () => {
      getCalls += 1;
      return { state: 'active' };
    };

    expect(await daytonaProvider.getSnapshotState('kortix-delete-outage')).toBe('active');

    deleteSnapshotImpl = async () => {
      throw Object.assign(new Error('upstream unavailable'), { statusCode: 503 });
    };

    await expect(daytonaProvider.deleteSnapshot('kortix-delete-outage')).rejects.toThrow(
      'upstream unavailable',
    );

    getSnapshotImpl = async () => {
      getCalls += 1;
      throw Object.assign(new Error('Snapshot with name kortix-delete-outage not found'), {
        statusCode: 404,
      });
    };

    expect(await daytonaProvider.getSnapshotState('kortix-delete-outage')).toBe('missing');
    expect(getCalls).toBe(3);
  });
});

describe('Daytona auto-build self-heal', () => {
  test('re-stages a FRESH context + retries on a stale-context error, then succeeds', async () => {
    contextPaths.length = 0;
    let attempt = 0;
    let built = false;
    createImpl = async () => {
      attempt += 1;
      if (attempt === 1) {
        // exactly the reported symptom: the SDK can't find scaffold.git in the context
        throw new Error('Path does not exist: /tmp/kortix-snap-OxOgZY/scaffold.git');
      }
      built = true; // 2nd attempt succeeds
    };
    snapshotState = () => (built ? 'active' : 'error');

    await daytonaProvider.buildSnapshot(buildInput('kortix-selfheal'));

    expect(attempt).toBe(2); // retried once — did NOT require a manual rebuild
    expect(contextPaths.length).toBe(2); // staged twice
    // Distinct temp dirs prove each attempt got a NEW context. The bug staged
    // ONCE outside the loop, so the disturbed context never recovered.
    expect(new Set(contextPaths).size).toBe(2);
  }, 15_000);

  test('does NOT retry a genuine build error — fails fast, no wasted rebuild', async () => {
    contextPaths.length = 0;
    let attempt = 0;
    createImpl = async () => {
      attempt += 1;
      throw new Error('podman build: unknown instruction FOOBAR on line 3');
    };
    snapshotState = () => 'error';

    await expect(daytonaProvider.buildSnapshot(buildInput('kortix-realfail'))).rejects.toThrow(
      /Snapshot build failed/,
    );
    expect(attempt).toBe(1); // a real build error is NOT re-staged/retried
    expect(contextPaths.length).toBe(1);
  }, 15_000);
});
