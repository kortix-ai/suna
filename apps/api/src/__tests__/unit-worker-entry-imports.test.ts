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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

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

/**
 * Registries a job fires into at runtime. A module registers its delivery at
 * import, so a process that never imports it drops the notice silently (a
 * reaped box's turn-lost notice never reaches the parent session).
 */
const NOTICE_REGISTRIES = /^(?:registerSessionFailureNotifier|registerTurnLostNotifier|registerSessionPort)\(/m;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [path] : [];
  });
}

const HTTP_LAYER = /^src\/(?:middleware\/|openapi\/|app\.ts$|index\.ts$|http-middleware\.ts$|[^/]+\/index\.ts$)|\/routes\/|-routes\.ts$/;

test('the worker entry loads every notice registration and no HTTP-layer module beyond the known leaks', () => {
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
    // Every module that registers a notice delivery at import is loaded.
    const registrations = sourceFiles(join(API_ROOT, 'src'))
      .filter((file) => NOTICE_REGISTRIES.test(readFileSync(file, 'utf8')))
      .map((file) => relative(API_ROOT, file));
    expect(registrations.length).toBeGreaterThan(0);
    expect(registrations.filter((file) => !inputs.includes(file))).toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
