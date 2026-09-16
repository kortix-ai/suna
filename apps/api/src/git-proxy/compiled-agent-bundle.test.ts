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
  test('the full daemon boots through Node and serves readiness', async () => {
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
    const listener = Bun.serve({ port: 0, fetch: () => new Response() });
    const staticListener = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = listener.port!;
    const staticPort = staticListener.port!;
    listener.stop(true);
    staticListener.stop(true);
    const resourceApi = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        project_id: 'test-project', session_id: 'test-session',
        agent_name: 'operator', source_sha: 'a'.repeat(40), files: [],
      }),
    });
    const runtime = Bun.spawn(['node', path], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: root, KORTIX_BUN_BIN: process.execPath,
        KORTIX_WORKLOAD: 'environment', KORTIX_TOKEN: 'test-runtime-token',
        KORTIX_SERVICE_PORT: String(port), KORTIX_STATIC_PORT: String(staticPort),
        KORTIX_WORKSPACE: root, KORTIX_PROJECT_TARGET: root,
        KORTIX_API_URL: `http://127.0.0.1:${resourceApi.port}/v1`,
        KORTIX_SESSION_ID: 'test-session', KORTIX_AGENT_NAME: 'operator',
        KORTIX_AGENT_STATE_DIR: join(root, 'resource-state'),
        KORTIX_DAEMON_LOG_FILE: 'off', KORTIX_RUNTIME_ASSETS_ENABLED: '0',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const runtimeOutput = new Response(runtime.stdout).text();
    const runtimeErrors = new Response(runtime.stderr).text();
    let finished = false;
    void runtime.exited.then(() => { finished = true; });
    try {
      let health: Record<string, unknown> | undefined;
      const deadline = Date.now() + 8000;
      while (!finished && Date.now() < deadline) {
        try {
          health = await (await fetch(`http://127.0.0.1:${port}/kortix/health`, { signal: AbortSignal.timeout(250) })).json();
          if (health?.runtimeReady === true) break;
        } catch {}
        await Bun.sleep(25);
      }
      expect(health, finished ? (await runtimeErrors).slice(0, 300) : 'readiness deadline').toMatchObject({
        runtimeReady: true, workload: 'environment', opencode: 'disabled',
      });
    } finally {
      runtime.kill('SIGTERM');
      await runtime.exited;
      await Promise.all([runtimeOutput, runtimeErrors]);
      resourceApi.stop(true);
    }
  }, 15000);

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
