import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCliConnectorSourceDigest,
  buildFileSha256,
} from '@kortix/shared/sandbox-runtime-artifact';

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
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona,platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');

const { stageBuildContext } = await import('./build-context');

const testRoots: string[] = [];
const envNames = [
  'TMPDIR',
  'KORTIX_SNAPSHOT_AGENT_BIN_PATH',
  'KORTIX_SNAPSHOT_CLI_BIN_PATH',
  'KORTIX_SNAPSHOT_CLI_ATTESTATION_PATH',
  'KORTIX_SNAPSHOT_ENTRYPOINT_PATH',
  'KORTIX_SNAPSHOT_SLACK_CLI_PATH',
  'KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH',
  'KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH',
  'KORTIX_SNAPSHOT_MACHINE_DOC_PATH',
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

async function createStagingFixture(): Promise<{ tempBase: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-context-cleanup-test-'));
  testRoots.push(root);
  const tempBase = join(root, 'tmp');
  const slackDir = join(root, 'slack-cli');
  const badConfigDir = join(root, 'opencode-config');
  await Promise.all([mkdir(tempBase), mkdir(slackDir), mkdir(badConfigDir)]);
  const agentPath = join(root, 'kortix-agent');
  const cliPath = join(root, 'kortix');
  const attestationPath = join(root, 'kortix.attestation.json');
  const entrypointPath = join(root, 'entrypoint.sh');
  const warmupPath = join(root, 'opencode-warmup.sh');
  const machinePath = join(root, 'MACHINE.md');
  await Promise.all([
    writeFile(agentPath, 'agent-fixture\n'),
    writeFile(cliPath, 'cli-fixture\n'),
    writeFile(entrypointPath, '#!/bin/sh\n'),
    writeFile(warmupPath, '#!/bin/sh\n'),
    writeFile(machinePath, 'fixture\n'),
    writeFile(join(slackDir, 'index.js'), 'export {};\n'),
  ]);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  await writeFile(
    attestationPath,
    `${JSON.stringify({
      schema_version: 1,
      source_sha256: await buildCliConnectorSourceDigest(join(repoRoot, 'apps/cli')),
      binary_sha256: await buildFileSha256(cliPath),
      target: 'bun-linux-x64',
    })}\n`,
  );
  process.env.TMPDIR = tempBase;
  process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH = agentPath;
  process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH = cliPath;
  process.env.KORTIX_SNAPSHOT_CLI_ATTESTATION_PATH = attestationPath;
  process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH = entrypointPath;
  process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH = slackDir;
  process.env.KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH = badConfigDir;
  process.env.KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH = warmupPath;
  process.env.KORTIX_SNAPSHOT_MACHINE_DOC_PATH = machinePath;
  return { tempBase };
}

/**
 * A Dockerfile that stages fine and then fails the buildah-portability guard —
 * the last step of `stageBuildContext`, so the failure lands AFTER the context
 * dir and every staged artifact exist. That is exactly the window the cleanup
 * has to cover.
 */
const UNPORTABLE_DOCKERFILE = 'FROM ubuntu:24.04\nRUN cat <<EOF\nhello\nEOF\n';

async function observeCreatedContext(
  tempBase: string,
  prefix: string,
  run: () => Promise<unknown>,
): Promise<{ contextDir: string; error: unknown }> {
  let resolveContext!: (path: string) => void;
  const contextCreated = new Promise<string>((resolveCreated) => {
    resolveContext = resolveCreated;
  });
  const watcher = watch(tempBase, (_event, filename) => {
    if (typeof filename === 'string' && filename.startsWith(prefix)) {
      resolveContext(join(tempBase, filename));
    }
  });
  const timeout = setTimeout(() => resolveContext(''), 2_000);
  try {
    let error: unknown;
    await run().catch((caught) => {
      error = caught;
    });
    const contextDir = await contextCreated;
    return { contextDir, error };
  } finally {
    clearTimeout(timeout);
    watcher.close();
  }
}

function currentTempBase(): string {
  const tempBase = process.env.TMPDIR;
  if (!tempBase) throw new Error('TMPDIR is missing from the staging fixture');
  return tempBase;
}

beforeEach(async () => {
  await createStagingFixture();
});

afterEach(async () => {
  for (const name of envNames) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('snapshot build-context failure cleanup', () => {
  test('stageBuildContext removes its exact context directory after staging fails', async () => {
    const tempBase = currentTempBase();
    const { contextDir, error } = await observeCreatedContext(tempBase, 'kortix-snap-', () =>
      stageBuildContext('cleanup-test', UNPORTABLE_DOCKERFILE),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('not buildah-portable');
    expect(contextDir.startsWith(join(tempBase, 'kortix-snap-'))).toBe(true);
    expect(await stat(contextDir).catch((caught) => (caught as NodeJS.ErrnoException).code)).toBe(
      'ENOENT',
    );
    expect(await readdir(tempBase)).toEqual([]);
  });
});
