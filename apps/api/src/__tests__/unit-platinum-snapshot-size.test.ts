import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'kortix-platinum-size-test-'));
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
await mkdir(opencodeConfigPath, { recursive: true });

type FromBuildPayload = {
  name: string;
  size_mb: number;
  default_disk_gb: number;
};

let fromBuildPayloads: FromBuildPayload[] = [];
let registeredTemplateName = '';

mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJson: async (path: string, init: RequestInit = {}) => {
    if (path === '/v1/templates/from-build/presign') {
      return { upload_url: 'https://upload.test/context.tar.gz', context_s3_key: 'ctx-key' };
    }
    if (path === '/v1/templates/from-build') {
      const payload = JSON.parse(String(init.body ?? '{}')) as FromBuildPayload;
      fromBuildPayloads.push(payload);
      registeredTemplateName = payload.name;
      return { id: 'tpl-1', name: payload.name, state: 'building' };
    }
    if (path === '/v1/templates') {
      return registeredTemplateName
        ? [{ id: 'tpl-1', name: registeredTemplateName, state: 'ready' }]
        : [];
    }
    throw new Error(`unexpected Platinum path: ${path}`);
  },
}));

// Capture the real fetch; install the 200-stub PER-TEST (beforeEach), NOT at
// module load — a module-level override here is process-global in bun and was
// clobbering sibling test files' fetch (it broke the daytona suite in combined runs).
const originalFetch = globalThis.fetch;
const stubFetch = Object.assign(
  async () => new Response('', { status: 200 }),
  { preconnect: originalFetch.preconnect },
) as typeof fetch;

const { platinumProvider, PLATINUM_MAX_BUILD_SIZE_MB } = await import('../snapshots/providers/platinum');

beforeEach(() => {
  fromBuildPayloads = [];
  registeredTemplateName = '';
  globalThis.fetch = stubFetch;
  // Per-test (not module load): build-context reads these lazily, so setting here
  // keeps this suite's fixtures from leaking into sibling suites in combined runs.
  process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH = agentPath;
  process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH = cliPath;
  process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH = entrypointPath;
  process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH = slackCliPath;
  process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH = executorSdkPath;
  process.env.KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH = opencodeConfigPath;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Platinum snapshot build sizing', () => {
  test('a disk under the cap is sent verbatim as the build ceiling', async () => {
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-small-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 10 },
      slug: 'small',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    expect(fromBuildPayloads[0].size_mb).toBe(10 * 1024); // < cap → unclamped
    expect(fromBuildPayloads[0].default_disk_gb).toBe(10);
  });

  test('clamps the build ext4 ceiling to Platinum\'s from-build cap, keeping the full runtime disk', async () => {
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-large-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 40 },
      slug: 'large',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    // 40 GiB * 1024 = 40960 > cap → clamped so Platinum doesn't 400 "size_mb too_big".
    expect(fromBuildPayloads[0].size_mb).toBe(PLATINUM_MAX_BUILD_SIZE_MB);
    // Runtime disk is NOT clamped — build ceiling != runtime disk (ext4 grows to fit).
    expect(fromBuildPayloads[0].default_disk_gb).toBe(40);
  });

  test('clamps even an extreme disk to the build cap', async () => {
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-max-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 500 },
      slug: 'max',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    expect(fromBuildPayloads[0].size_mb).toBe(PLATINUM_MAX_BUILD_SIZE_MB);
    expect(fromBuildPayloads[0].default_disk_gb).toBe(500);
  });
});
