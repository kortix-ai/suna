import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileOpenCodeRuntime } from './compiled-runtime';

const roots: string[] = [];
const INPUT = {
  projectId: 'project-1',
  ref: 'main',
  sourceSha: 'a'.repeat(40),
  agentConfig: JSON.stringify({ agent: { kortix: { prompt: 'Ship safely.' } } }),
  agentBundle: 'process.exit(0);',
};

async function materializeRuntime(agentBundle = INPUT.agentBundle) {
  const root = await mkdtemp(join(tmpdir(), 'kortix-compiled-runtime-'));
  roots.push(root);
  const artifact = compileOpenCodeRuntime({ ...INPUT, agentBundle });
  const runtimePath = join(root, 'server.mjs');
  await writeFile(runtimePath, artifact.source, { mode: 0o700 });
  return { artifact, root, runtimePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('compileOpenCodeRuntime', () => {
  test('produces a deterministic content-addressed OpenCode runtime', () => {
    const first = compileOpenCodeRuntime(INPUT);
    const second = compileOpenCodeRuntime(INPUT);

    expect(second).toEqual(first);
    expect(first.manifest).toEqual({
      format: 'kortix.compiled-runtime.v1',
      engine: 'opencode',
      project_id: 'project-1',
      ref: 'main',
      source_sha: 'a'.repeat(40),
      agent_config: INPUT.agentConfig,
      agent_config_etag: expect.stringMatching(/^[0-9a-f]{16}$/),
      opencode_config_dir: null,
      opencode_config_archive_sha256: null,
      opencode_config_archive_bytes: null,
    });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.size).toBe(Buffer.byteLength(first.source));
  });

  test('contains the supplied daemon bundle instead of launching the baked agent', () => {
    const bundleMarker = 'globalThis.__KORTIX_COMPILED_DAEMON__ = true;';
    const artifact = compileOpenCodeRuntime({
      ...INPUT,
      agentBundle: bundleMarker,
    });

    expect(artifact.source).toContain(bundleMarker);
    expect(artifact.source).not.toContain('KORTIX_AGENT_BIN');
  });

  test('prints its compiled manifest without starting the agent', async () => {
    const { artifact, runtimePath } = await materializeRuntime();
    const child = Bun.spawn([process.execPath, runtimePath, '--manifest'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(artifact.manifest);
  });

  test('runs the bundled daemon with compiled config and runtime secrets', async () => {
    const { root } = await materializeRuntime();
    const capturePath = join(root, 'capture.json');
    const { runtimePath } = await materializeRuntime(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  projectId: process.env.KORTIX_PROJECT_ID,
  ref: process.env.KORTIX_DEFAULT_BRANCH,
  sourceSha: process.env.KORTIX_BASE_SHA,
  runtimeFormat: process.env.KORTIX_COMPILED_RUNTIME_FORMAT,
  agentConfig: process.env.KORTIX_COMPILED_AGENT_CONFIG,
  token: process.env.KORTIX_TOKEN,
}));
`);
    const child = Bun.spawn([process.execPath, runtimePath], {
      env: {
        ...process.env,
        CAPTURE_PATH: capturePath,
        KORTIX_TOKEN: 'runtime-only-token',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
      projectId: 'project-1',
      ref: 'main',
      sourceSha: 'a'.repeat(40),
      runtimeFormat: 'kortix.compiled-runtime.v1',
      agentConfig: INPUT.agentConfig,
      token: 'runtime-only-token',
    });
    expect(artifactSourceHasSecret(await readFile(runtimePath, 'utf8'))).toBe(false);
  });

  test('extracts the compiled OpenCode config before running the daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-compiled-config-'));
    roots.push(root);
    const sourceDir = join(root, 'source');
    const extractionRoot = join(root, 'extracted');
    const capturePath = join(root, 'capture.json');
    const archivePath = join(root, 'opencode-config.tar.gz');
    await mkdir(join(sourceDir, 'agents'), { recursive: true });
    await writeFile(join(sourceDir, 'opencode.jsonc'), '{"default_agent":"kortix"}\n');
    await writeFile(join(sourceDir, 'agents', 'kortix.md'), 'Compiled config marker.\n');
    execFileSync('tar', ['-czf', archivePath, '-C', sourceDir, '.']);
    const archive = await readFile(archivePath);
    const artifact = compileOpenCodeRuntime({
      ...INPUT,
      opencodeConfigDir: '.kortix/opencode',
      opencodeConfigArchiveBase64: archive.toString('base64'),
      agentBundle: `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  configDir: process.env.KORTIX_COMPILED_OPENCODE_CONFIG_DIR,
  config: readFileSync(join(process.env.KORTIX_COMPILED_OPENCODE_CONFIG_DIR, "opencode.jsonc"), "utf8"),
  agent: readFileSync(join(process.env.KORTIX_COMPILED_OPENCODE_CONFIG_DIR, "agents", "kortix.md"), "utf8"),
}));
`,
    });
    const runtimePath = join(root, 'server.mjs');
    await writeFile(runtimePath, artifact.source, { mode: 0o700 });

    const child = Bun.spawn([process.execPath, runtimePath], {
      env: {
        ...process.env,
        CAPTURE_PATH: capturePath,
        KORTIX_COMPILED_CONFIG_ROOT: extractionRoot,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
      configDir: expect.stringContaining(extractionRoot),
      config: '{"default_agent":"kortix"}\n',
      agent: 'Compiled config marker.\n',
    });
    expect(artifact.manifest.opencode_config_dir).toBe('.kortix/opencode');
    expect(artifact.manifest.opencode_config_archive_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('uses Bun to run the bundle when an older snapshot invokes it with Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-compiled-runtime-'));
    roots.push(root);
    const capturePath = join(root, 'node-trampoline.txt');
    const { runtimePath } = await materializeRuntime(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_PATH, typeof Bun);
`);
    const child = Bun.spawn(['node', runtimePath], {
      env: {
        ...process.env,
        CAPTURE_PATH: capturePath,
        KORTIX_BUN_BIN: process.execPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(await readFile(capturePath, 'utf8')).toBe('object');
  });

  test('rejects a runtime identity that differs from the compiled artifact', async () => {
    const { runtimePath } = await materializeRuntime();
    const child = Bun.spawn([process.execPath, runtimePath], {
      env: {
        ...process.env,
        KORTIX_PROJECT_ID: 'different-project',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(78);
    expect(stderr).toContain('Compiled runtime identity mismatch for KORTIX_PROJECT_ID');
  });

  test('rejects malformed compiler input', () => {
    expect(() => compileOpenCodeRuntime({ ...INPUT, sourceSha: 'HEAD' })).toThrow(
      'sourceSha must be a lowercase 40-character Git SHA',
    );
    expect(() => compileOpenCodeRuntime({ ...INPUT, agentConfig: '{' })).toThrow();
    expect(() => compileOpenCodeRuntime({ ...INPUT, agentBundle: '' })).toThrow(
      'agentBundle is required',
    );
  });
});

function artifactSourceHasSecret(source: string): boolean {
  return source.includes('runtime-only-token');
}
