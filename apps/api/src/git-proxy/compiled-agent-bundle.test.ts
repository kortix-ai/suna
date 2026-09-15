import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileOpenCodeRuntime } from './compiled-runtime';
import {
  getCompiledAgentBundle,
  resetCompiledAgentBundleForTests,
} from './compiled-agent-bundle';

const roots: string[] = [];
const originalOverride = process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  resetCompiledAgentBundleForTests();
});

afterEach(async () => {
  resetCompiledAgentBundleForTests();
  if (originalOverride === undefined) delete process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH;
  else process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = originalOverride;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('getCompiledAgentBundle', () => {
  test('the real daemon exports deferred startup and its manifest works through Node', async () => {
    delete process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH;
    process.env.NODE_ENV = 'test';
    const root = await mkdtemp(join(tmpdir(), 'kortix-real-agent-bundle-'));
    roots.push(root);
    const daemonPath = join(root, 'daemon.mjs');
    const compiler = Bun.spawn([process.execPath, '--eval', `const { getCompiledAgentBundle } = await import(${JSON.stringify(new URL('./compiled-agent-bundle.ts', import.meta.url).href)}); await Bun.write(${JSON.stringify(daemonPath)}, (await getCompiledAgentBundle()).source);`], { stdout: 'pipe', stderr: 'pipe' });
    const [buildCode, buildError] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()]);
    expect(buildCode, buildError).toBe(0);
    const source = await readFile(daemonPath, 'utf8');
    const child = Bun.spawn([process.execPath, '--eval', `const daemon = await import(${JSON.stringify(pathToFileURL(daemonPath).href)}); if (typeof daemon.startCompiledRuntime !== 'function') process.exit(1);`], { stdout: 'pipe', stderr: 'pipe' });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const artifact = compileOpenCodeRuntime({ projectId: 'test-project', ref: 'main', sourceSha: 'a'.repeat(40), agentBundle: source });
    const path = join(root, 'server.mjs');
    await writeFile(path, artifact.source);
    const manifest = Bun.spawn(['node', path, '--manifest'], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, error] = await Promise.all([manifest.exited, new Response(manifest.stdout).text(), new Response(manifest.stderr).text()]);
    expect(code, error).toBe(0);
    expect(JSON.parse(stdout)).toEqual(artifact.manifest);
  });

  test('loads and fingerprints a verified prebuilt daemon bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-agent-bundle-'));
    roots.push(root);
    const path = join(root, 'server.mjs');
    const source = 'export function startCompiledRuntime() { console.log("kortix-sandbox-agent-server starting"); }\n';
    await writeFile(path, source);
    process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = path;

    const bundle = await getCompiledAgentBundle();

    expect(bundle.source).toBe(source);
    expect(bundle.size).toBe(Buffer.byteLength(source));
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a file that is not the daemon bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-agent-bundle-'));
    roots.push(root);
    const path = join(root, 'server.mjs');
    await writeFile(path, 'process.exit(0);\n');
    process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = path;

    await expect(getCompiledAgentBundle()).rejects.toThrow('has no daemon entrypoint');
  });

  test('rejects an old daemon bundle without deferred startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-old-agent-bundle-'));
    roots.push(root);
    const path = join(root, 'server.mjs');
    await writeFile(path, 'console.log("kortix-sandbox-agent-server starting");\n');
    process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = path;
    await expect(getCompiledAgentBundle()).rejects.toThrow('no deferred startup export');
  });
});
