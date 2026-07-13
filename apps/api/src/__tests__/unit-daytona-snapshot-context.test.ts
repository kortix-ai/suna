import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
await symlink('/definitely-not-present/typescript', join(executorSdkPath, 'node_modules', 'typescript'));
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
      get: async () => ({ state: snapshotState() }),
      delete: async () => undefined,
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
