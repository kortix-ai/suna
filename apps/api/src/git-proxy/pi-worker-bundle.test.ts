import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { __resetPiWorkerBundleForTests, getPiWorkerBundle } from './pi-worker-bundle';
import { compilePiRuntime } from './compiled-pi-runtime';

const WORKER_DIST = resolve(
  import.meta.dir,
  '../../../kortix-worker/dist/worker-runtime.mjs',
);

const roots: string[] = [];
afterEach(async () => {
  __resetPiWorkerBundleForTests();
  delete process.env.KORTIX_PI_WORKER_BUNDLE_PATH;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('getPiWorkerBundle', () => {
  test('rejects a bundle without the worker entrypoint sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-pi-bundle-'));
    roots.push(root);
    const bogus = join(root, 'bogus.mjs');
    await writeFile(bogus, 'console.log("not a worker");\n');
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = bogus;
    expect(getPiWorkerBundle()).rejects.toThrow(/no worker entrypoint/);
  });

  test('a failed load does not poison later loads', async () => {
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = '/nonexistent/worker.mjs';
    await expect(getPiWorkerBundle()).rejects.toThrow();
    // Point at a valid bundle and the next call must succeed.
    const root = await mkdtemp(join(tmpdir(), 'kortix-pi-bundle-'));
    roots.push(root);
    const ok = join(root, 'ok.mjs');
    await writeFile(ok, 'console.log("kortix-worker starting");\n');
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = ok;
    const bundle = await getPiWorkerBundle();
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// The end-to-end shape the pipeline exists to produce: the REAL worker runtime
// (apps/kortix-worker/dist), compiled with a project's baked config, booted as
// the artifact would boot in a worker sandbox, serving /health. Skipped when
// the dist bundle has not been built (CI builds it in the Docker stage; run
// `bun run build` in apps/kortix-worker locally).
describe.skipIf(!existsSync(WORKER_DIST))('compiled pi runtime artifact (real bundle)', () => {
  test('boots under node and serves /health with the baked identity', async () => {
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = WORKER_DIST;
    const bundle = await getPiWorkerBundle();
    const artifact = compilePiRuntime({
      projectId: 'project-e2e',
      ref: 'main',
      sourceSha: 'b'.repeat(40),
      agentConfig: JSON.stringify({
        agent: { dev: { prompt: 'You are the compiled dev agent.' } },
      }),
      defaultAgent: 'dev',
      workerBundle: bundle.source,
    });

    const root = await mkdtemp(join(tmpdir(), 'kortix-pi-e2e-'));
    roots.push(root);
    const runtimePath = join(root, 'worker.mjs');
    await writeFile(runtimePath, artifact.source, { mode: 0o700 });

    const port = 18300 + Math.floor(Math.random() * 500);
    const child = spawn('node', [runtimePath], {
      env: {
        ...process.env,
        PORT: String(port),
        KORTIX_MODEL_MODE: 'faux',
        KORTIX_PROJECT_ID: 'project-e2e',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let health: { ok?: boolean } | null = null;
      for (let i = 0; i < 100; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) {
            health = (await res.json()) as { ok?: boolean };
            break;
          }
        } catch {
          // not listening yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(health?.ok).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);
});
