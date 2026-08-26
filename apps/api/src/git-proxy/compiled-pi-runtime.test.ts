import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPILED_PI_RUNTIME_FORMAT,
  compilePiRuntime,
  type CompilePiRuntimeInput,
} from './compiled-pi-runtime';

const roots: string[] = [];
const INPUT: CompilePiRuntimeInput = {
  projectId: 'project-1',
  ref: 'main',
  sourceSha: 'a'.repeat(40),
  agentConfig: JSON.stringify({
    model: 'openrouter/anthropic/claude-sonnet-4.5',
    agent: { kortix: { prompt: 'Ship safely.', model: 'openrouter/anthropic/claude-sonnet-4.5' } },
  }),
  defaultAgent: 'kortix',
  // A stand-in worker bundle that proves the baked config actually reached the
  // runtime half: it prints what the prelude injected, then exits.
  workerBundle:
    'console.log("kortix-worker starting");\n' +
    'console.log(JSON.stringify({ baked: globalThis.__KORTIX_COMPILED__ }));\n' +
    'process.exit(0);\n',
};

async function materialize(input = INPUT) {
  const root = await mkdtemp(join(tmpdir(), 'kortix-compiled-pi-'));
  roots.push(root);
  const artifact = compilePiRuntime(input);
  const runtimePath = join(root, 'worker.mjs');
  await writeFile(runtimePath, artifact.source, { mode: 0o700 });
  return { artifact, runtimePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('compilePiRuntime', () => {
  test('produces a deterministic content-addressed pi runtime', () => {
    const first = compilePiRuntime(INPUT);
    const second = compilePiRuntime(INPUT);

    expect(second).toEqual(first);
    // The etag is asserted by shape separately: mixing an asymmetric matcher
    // into a typed object literal fails tsc's toEqual overloads.
    const { agent_config_etag, ...manifest } = first.manifest;
    expect(agent_config_etag).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest).toEqual({
      format: COMPILED_PI_RUNTIME_FORMAT,
      engine: 'pi',
      project_id: 'project-1',
      ref: 'main',
      source_sha: 'a'.repeat(40),
      default_agent: 'kortix',
      agent_config: INPUT.agentConfig ?? null,
    });
    expect(first.size).toBe(Buffer.byteLength(first.source));
  });

  test('embeds the manifest as a parseable marker on line 2', () => {
    const artifact = compilePiRuntime(INPUT);
    const marker = artifact.source
      .split('\n', 4)
      .find((line) => line.startsWith('// kortix-manifest-base64url:'));
    expect(marker).toBeDefined();
    const encoded = marker!.slice('// kortix-manifest-base64url:'.length).trim();
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(
      artifact.manifest,
    );
  });

  test('--manifest prints the manifest without starting the worker', async () => {
    const { artifact, runtimePath } = await materialize();
    const stdout = execFileSync(process.execPath, [runtimePath, '--manifest'], {
      encoding: 'utf8',
    });
    expect(JSON.parse(stdout)).toEqual(artifact.manifest);
  });

  test('the worker runtime receives the baked config via __KORTIX_COMPILED__', async () => {
    const { runtimePath } = await materialize();
    const stdout = execFileSync(process.execPath, [runtimePath], { encoding: 'utf8' });
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe('kortix-worker starting');
    const baked = JSON.parse(lines[1]).baked;
    expect(baked.manifest.source_sha).toBe('a'.repeat(40));
    expect(baked.manifest.default_agent).toBe('kortix');
    expect(baked.agentConfig.agent.kortix.prompt).toBe('Ship safely.');
  });

  test('a baked identity env mismatch fails closed with exit 78', async () => {
    const { runtimePath } = await materialize();
    let exitCode: number | null = null;
    try {
      execFileSync(process.execPath, [runtimePath], {
        encoding: 'utf8',
        env: { ...process.env, KORTIX_PROJECT_ID: 'someone-else' },
      });
    } catch (error) {
      exitCode = (error as { status: number | null }).status;
    }
    expect(exitCode).toBe(78);
  });

  test('a null agent config compiles and bakes null', async () => {
    const { artifact, runtimePath } = await materialize({
      ...INPUT,
      agentConfig: null,
      defaultAgent: null,
    });
    expect(artifact.manifest.agent_config).toBeNull();
    expect(artifact.manifest.agent_config_etag).toBeNull();
    const stdout = execFileSync(process.execPath, [runtimePath], { encoding: 'utf8' });
    expect(JSON.parse(stdout.trim().split('\n')[1]).baked.agentConfig).toBeNull();
  });

  test('rejects malformed inputs before emitting anything', () => {
    expect(() => compilePiRuntime({ ...INPUT, sourceSha: 'short' })).toThrow(
      /40-character Git SHA/,
    );
    expect(() => compilePiRuntime({ ...INPUT, agentConfig: '{not json' })).toThrow();
    expect(() => compilePiRuntime({ ...INPUT, workerBundle: '  ' })).toThrow(
      /workerBundle is required/,
    );
    expect(() => compilePiRuntime({ ...INPUT, projectId: ' ' })).toThrow(/projectId/);
  });
});
