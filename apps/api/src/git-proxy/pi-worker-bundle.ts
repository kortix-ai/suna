/**
 * The pi worker runtime bundle — the generic half of a compiled pi runtime.
 *
 * Same dual-source contract as ./compiled-agent-bundle.ts (the daemon bundle):
 * production reads the artifact the Docker `worker-runtime` stage built
 * (`apps/kortix-worker/dist/worker-runtime.mjs`); development builds it from
 * source with `Bun.build` so an edit to apps/kortix-worker is live on the next
 * compile without a manual build step. `KORTIX_PI_WORKER_BUNDLE_PATH`
 * overrides both for tests and unusual deployments.
 *
 * The bundle is loaded once per process and cached: it changes only when the
 * API deploys, and its sha256 is part of every compiled artifact's cache key,
 * so a new deploy invalidates exactly the artifacts it should.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface PiWorkerBundle {
  source: string;
  sha256: string;
  size: number;
}

let bundlePromise: Promise<PiWorkerBundle> | null = null;

function workerRoot(): string {
  return resolve(import.meta.dir, '../../../kortix-worker');
}

function validateBundle(source: string): PiWorkerBundle {
  if (!source.trim()) throw new Error('pi worker runtime bundle is empty');
  // The sentinel is asserted at build time too (apps/kortix-worker/scripts/
  // build.sh); checking again here catches a stale or truncated dist file.
  if (!source.includes('kortix-worker starting')) {
    throw new Error('pi worker runtime bundle has no worker entrypoint');
  }
  return {
    source,
    sha256: createHash('sha256').update(source).digest('hex'),
    size: Buffer.byteLength(source),
  };
}

async function buildDevelopmentBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(workerRoot(), 'src/main.ts')],
    root: workerRoot(),
    // The worker artifact runs under plain node in the minimal worker image,
    // not under bun — unlike the daemon bundle right above this one.
    target: 'node',
    format: 'esm',
    sourcemap: 'none',
  });
  if (!result.success || result.outputs.length !== 1) {
    const details = result.logs.map((log) => log.message).join('; ');
    throw new Error(`pi worker runtime build failed${details ? `: ${details}` : ''}`);
  }
  return result.outputs[0]!.text();
}

async function loadBundle(): Promise<PiWorkerBundle> {
  const override = process.env.KORTIX_PI_WORKER_BUNDLE_PATH?.trim();
  if (override) return validateBundle(await readFile(override, 'utf8'));
  const source =
    process.env.NODE_ENV === 'production'
      ? await readFile(resolve(workerRoot(), 'dist/worker-runtime.mjs'), 'utf8')
      : await buildDevelopmentBundle();
  return validateBundle(source);
}

export function getPiWorkerBundle(): Promise<PiWorkerBundle> {
  if (!bundlePromise) {
    bundlePromise = loadBundle().catch((error) => {
      // A failed load must not poison the process: the next caller retries.
      bundlePromise = null;
      throw error;
    });
  }
  return bundlePromise;
}

export function __resetPiWorkerBundleForTests(): void {
  bundlePromise = null;
}
