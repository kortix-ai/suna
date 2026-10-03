import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Route warmup in scripts/dev-local.sh.
 *
 * The warmup used to live in an anonymous subshell whose header-array
 * expansion (`"${_hdr[@]}"`) crashed under `set -u` when no session cookie
 * could be minted — fatal on macOS bash 3.2, the exact class kill_dev_ports
 * already documents and guards. The unauthed compile-only fallback therefore
 * died before warming anything and before printing its completion message.
 *
 * These tests execute the REAL definitions from scripts/dev-local.sh (the
 * extraction pulls the function text, never a copy) against a local fake web
 * server, with no SUPABASE_SERVICE_ROLE_KEY, so the unauthed fallback must
 * run to completion. The `BASH32_BIN` leg re-runs the same harness under a
 * bash < 4 binary (macOS ships 3.2.57): the guard's absence aborts there.
 * When BASH32_BIN is unset the leg is skipped — set it to any bash 3.2-4.3
 * binary to exercise it.
 */

const root = resolve(import.meta.dirname, '../..');
const script = readFileSync(resolve(root, 'scripts/dev-local.sh'), 'utf8');

const WARM_ROUTES = [
  '/projects',
  '/projects/warmup-id',
  '/projects/warmup-id/sessions/warmup-id',
  '/projects/warmup-id/files',
];
// The `until` readiness probe hits `/` before the first warm route.
const EXPECTED_HITS = ['/', ...WARM_ROUTES];

function extractFunction(name: string): string {
  const start = script.indexOf(`${name}() {`);
  expect(
    start,
    `scripts/dev-local.sh no longer defines ${name}() — retarget this test`,
  ).toBeGreaterThan(-1);
  const end = script.indexOf('\n}', start);
  expect(end, `${name}() has no top-level closing brace — retarget this test`).toBeGreaterThan(
    start,
  );
  return script.slice(start, end + 2);
}

/** Harness: the real function definitions under the same `set -euo pipefail`
 * the script runs with, then one call. One file so the bash invocation is a
 * single process, exactly like the backgrounded call in dev-local.sh. */
function writeHarness(dir: string): string {
  const path = join(dir, 'warmup-harness.sh');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      extractFunction('mint_warm_session_cookie'),
      extractFunction('warm_frontend_routes'),
      'warm_frontend_routes',
      '',
    ].join('\n'),
  );
  return path;
}

describe('dev-local.sh warm_frontend_routes: the unauthed fallback completes', () => {
  let server: Server;
  let port = 0;
  let hits: { path: string; cookie: string | undefined }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ path: req.url ?? '', cookie: req.headers.cookie });
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as { port: number }).port;
  });

  beforeEach(() => {
    hits = [];
  });

  afterAll(() => {
    server.close();
  });

  async function runWarmup(bashBin: string) {
    const dir = mkdtempSync(join(tmpdir(), 'warmup-'));
    try {
      const harness = writeHarness(dir);
      const env = { ...process.env, WEB_PORT: String(port) } as Record<string, string | undefined>;
      delete env.SUPABASE_SERVICE_ROLE_KEY; // force the unauthed fallback
      // Async spawn, never spawnSync: the fake server answers from this same
      // worker's event loop, which a blocking spawn would freeze (the harness
      // waits for the server, the server waits for the loop — a deadlock).
      const child = spawn(bashBin, [harness], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      const done = await new Promise<[number | null, string, string]>((resolve) => {
        const out: string[] = [];
        const err: string[] = [];
        child.stdout?.on('data', (chunk: Buffer) => out.push(String(chunk)));
        child.stderr?.on('data', (chunk: Buffer) => err.push(String(chunk)));
        child.on('close', (code) => resolve([code, out.join(''), err.join('')]));
      });
      clearTimeout(killer);
      return { status: done[0], stdout: done[1], stderr: done[2] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function expectWarmupCompleted(bashBin: string) {
    const run = await runWarmup(bashBin);
    const label = bashBin === process.env.BASH32_BIN ? bashBin : 'system bash';
    expect(
      run.status,
      `${label}: warmup exited ${run.status} — stdout: ${run.stdout} stderr: ${run.stderr}`,
    ).toBe(0);
    expect(run.stdout).toContain('frontend routes pre-compiled (unauthed');
    expect(hits.map((h) => h.path)).toEqual(EXPECTED_HITS);
    expect(
      hits.every((h) => h.cookie === undefined),
      'no cookie may be sent on the unauthed path',
    ).toBe(true);
  }

  it('dev-local.sh parses', () => {
    expect(spawnSync('bash', ['-n', resolve(root, 'scripts/dev-local.sh')]).status).toBe(0);
  });

  it('warms the four routes and reports completion without a service-role key', async () => {
    await expectWarmupCompleted('bash');
  });

  it('does the same under bash < 4 when BASH32_BIN names such a binary', async (ctx) => {
    const bash32 = process.env.BASH32_BIN;
    if (!bash32) {
      ctx.skip(); // the sandbox has no bash 3.2 binary; set BASH32_BIN to run this leg
      return;
    }
    await expectWarmupCompleted(bash32);
  });
});
