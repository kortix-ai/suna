/**
 * The worker (`src/worker.ts`) runs scheduled jobs and serves no request, so
 * it must not load the HTTP layer: route files, domain route mounts, the app,
 * or the request middleware. This bundles the worker entry the way Bun loads
 * it and lists every HTTP-layer file in its import graph.
 *
 * KNOWN_LEAKS are the HTTP-layer files the worker still loads because a
 * service module imports a helper that lives next to the routes. The list may
 * only shrink: a new leak fails, and a fixed leak fails until its line is
 * removed here.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_ROOT = new URL('../..', import.meta.url).pathname;

const KNOWN_LEAKS: Record<string, string> = {
  'src/iam/index.ts': 'service modules import authorize helpers from the iam barrel',
  'src/middleware/actor.ts': 'iam/actor.ts and projects/lib/http-approval-caller.ts build actors with it',
  'src/middleware/agent-scope.ts': 'iam/agent-scope.ts re-exports it',
  'src/middleware/caller-session.ts': 'projects/lib/http-approval-caller.ts',
  'src/middleware/client-ip.ts': 'reached through middleware/request-audit.ts',
  'src/middleware/on-behalf-of.ts': 'projects/lib/on-behalf-of.ts and http-personal-resources.ts',
  'src/middleware/request-audit.ts': 'projects/lib/serializers.ts',
  'src/middleware/upstream-timing.ts': 'sandbox-proxy/backend.ts and forward/upstream.ts',
  'src/openapi/index.ts': 'domain app.ts modules that services import build their Hono app with it',
};

const HTTP_LAYER = /^src\/(?:middleware\/|openapi\/|app\.ts$|index\.ts$|http-middleware\.ts$|[^/]+\/index\.ts$)|\/routes\/|-routes\.ts$/;

test('the worker entry loads no HTTP-layer module beyond the known leaks', () => {
  const out = mkdtempSync(join(tmpdir(), 'worker-imports-'));
  try {
    const build = Bun.spawnSync(
      [process.execPath, 'build', 'src/worker.ts', '--target=bun', '--packages=external',
        `--metafile=${join(out, 'meta.json')}`, `--outdir=${join(out, 'bundle')}`],
      { cwd: API_ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const inputs = Object.keys(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')).inputs as object);
    const http = inputs.filter((file) => HTTP_LAYER.test(file)).sort();

    expect(http.filter((file) => !(file in KNOWN_LEAKS))).toEqual([]);
    expect(Object.keys(KNOWN_LEAKS).filter((file) => !http.includes(file))).toEqual([]);
    // The scheduled jobs and their runtime are in the graph.
    expect(inputs).toContain('src/worker/jobs/index.ts');
    expect(inputs).toContain('src/worker/runtime/jobs.ts');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
