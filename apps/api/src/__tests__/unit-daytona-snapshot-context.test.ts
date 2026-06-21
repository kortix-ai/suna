import { afterAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'kortix-daytona-context-test-'));
const agentPath = join(fixtureRoot, 'kortix-agent');
const cliPath = join(fixtureRoot, 'kortix');
const entrypointPath = join(fixtureRoot, 'entrypoint.sh');
const agentCliPath = join(fixtureRoot, 'agent-cli');
const executorSdkPath = join(fixtureRoot, 'executor-sdk');
const opencodeConfigPath = join(fixtureRoot, 'opencode-config');

writeFileSync(agentPath, '#!/bin/sh\n');
writeFileSync(cliPath, '#!/bin/sh\n');
writeFileSync(entrypointPath, '#!/bin/sh\n');
await chmod(agentPath, 0o755);
await chmod(cliPath, 0o755);
await chmod(entrypointPath, 0o755);
await mkdir(agentCliPath, { recursive: true });
await mkdir(executorSdkPath, { recursive: true });
await mkdir(opencodeConfigPath, { recursive: true });

process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH = agentPath;
process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH = cliPath;
process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH = entrypointPath;
process.env.KORTIX_SNAPSHOT_AGENT_CLI_PATH = agentCliPath;
process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH = executorSdkPath;
process.env.KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH = opencodeConfigPath;

let dockerfileSeen = '';
let imageFromDockerfile: unknown;
let imagePassedToCreate: unknown;
let missingCopySourcesAtDaytonaBoundary: string[] = [];

mock.module('@daytonaio/sdk', () => ({
  Image: {
    fromDockerfile(path: string) {
      dockerfileSeen = readFileSync(path, 'utf8');
      const contextDir = dirname(path);
      missingCopySourcesAtDaytonaBoundary = dockerfileSeen
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('COPY '))
        .flatMap((line) => {
          const tokens = line.split(/\s+/).slice(1);
          while (tokens[0]?.startsWith('--')) tokens.shift();
          return tokens.slice(0, -1);
        })
        .map((source) => source.replace(/\/$/, ''))
        .filter((source) => !existsSync(join(contextDir, source)));
      imageFromDockerfile = { kind: 'mock-image', path };
      return imageFromDockerfile;
    },
  },
}));

mock.module('../shared/daytona', () => ({
  getDaytona: () => ({
    snapshot: {
      create: async (input: { image: unknown }) => {
        imagePassedToCreate = input.image;
      },
      get: async () => ({ state: 'active' }),
      delete: async () => undefined,
    },
  }),
  isDaytonaConfigured: () => true,
}));

const { daytonaProvider } = await import('../snapshots/providers/daytona');

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Daytona snapshot build context', () => {
  test('stages every file referenced by the generated Dockerfile before calling Daytona', async () => {
    await daytonaProvider.buildSnapshot({
      snapshotName: 'kortix-test-context',
      image: 'ubuntu:24.04',
      spec: {},
      slug: 'default',
    });

    expect(dockerfileSeen).toContain('COPY scaffold.git /opt/kortix/scaffold.git');
    expect(imagePassedToCreate).toBe(imageFromDockerfile);
    expect(missingCopySourcesAtDaytonaBoundary).toEqual([]);
  });
});
