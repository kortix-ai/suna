import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compilePiRuntime } from '../git-proxy/compiled-pi-runtime';
import { __resetPiWorkerBundleForTests, getPiWorkerBundle } from '../git-proxy/pi-worker-bundle';
import { piWorkerNodeArgs, piWorkerParkScriptForTest } from './build-context';

/**
 * Requirement 8 of the harness/worker split — "the worker is locked down; a
 * tool must not touch its disk" — at the level the huddle asked for: the OS,
 * not the tool implementations.
 *
 * `isolation.test.ts` proves the tools WE ship never write locally. It cannot
 * say anything about a tool a user bundles into the artifact, and that is the
 * failure mode the huddle named ("if a user implements a tool that will use the
 * local file system ... it will start fucking up with the sandbox"). Node's
 * permission model closes it: under the argv `piWorkerNodeArgs` returns, the
 * process cannot write anywhere, read anything but its artifact, or spawn.
 *
 * Three claims, each its own test:
 *   1. the flags deny what they must and allow what the worker needs;
 *   2. BOTH boot paths (cold entrypoint, park claim) run under them;
 *   3. the REAL compiled bundle boots and completes a tool turn under them —
 *      so a flag the runtime cannot live with fails here, not on a box.
 */

const WORKER_DIST = resolve(import.meta.dir, '../../../kortix-worker/dist/worker-runtime.mjs');

const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const s of servers.splice(0)) s.close();
  __resetPiWorkerBundleForTests();
  delete process.env.KORTIX_PI_WORKER_BUNDLE_PATH;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeDir(): Promise<string> {
  // realpath: the permission model matches the path node OPENS, and macOS's
  // tmpdir lives behind the /var -> /private/var symlink.
  const dir = await mkdtemp(join(realpathSync(tmpdir()), 'kortix-pi-lockdown-'));
  roots.push(dir);
  return dir;
}

function runNode(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function waitFor(url: string, init: RequestInit = {}, tries = 120): Promise<Response | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe('pi worker lockdown — the permission model', () => {
  test('denies writes, foreign reads and child processes; allows the artifact, /proc/uptime and the network', async () => {
    const dir = await runtimeDir();
    // The probe IS the artifact: only that path is readable, and node must be
    // able to load its own entrypoint.
    const probe = join(dir, 'session-worker.mjs');
    await writeFile(
      probe,
      `
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
const out = {};
const attempt = (name, fn) => { try { fn(); out[name] = 'allowed'; } catch (e) { out[name] = e.code ?? String(e); } };
attempt('write_runtime_dir', () => writeFileSync(${JSON.stringify(join(dir, 'leak.txt'))}, 'x'));
attempt('write_tmp', () => writeFileSync('/tmp/kortix-lockdown-leak-' + process.pid, 'x'));
attempt('read_foreign', () => readFileSync('/etc/hosts', 'utf8'));
attempt('spawn', () => execSync('id'));
attempt('read_self', () => readFileSync(${JSON.stringify(probe)}, 'utf8'));
attempt('read_uptime', () => readFileSync('/proc/uptime', 'utf8'));
const server = createServer().listen(0, '127.0.0.1', () => {
  out.listen = 'allowed';
  server.close(() => { process.stdout.write(JSON.stringify(out)); process.exit(0); });
});
`,
    );
    const { code, stdout, stderr } = await runNode([...piWorkerNodeArgs(dir), probe]);
    expect(stderr, stderr).not.toMatch(/Warning/);
    expect(code, `probe exited ${code}: ${stderr.slice(0, 600)}`).toBe(0);
    const out = JSON.parse(stdout) as Record<string, string>;
    expect(out.write_runtime_dir).toBe('ERR_ACCESS_DENIED');
    expect(out.write_tmp).toBe('ERR_ACCESS_DENIED');
    expect(out.read_foreign).toBe('ERR_ACCESS_DENIED');
    expect(out.spawn).toBe('ERR_ACCESS_DENIED');
    expect(out.read_self).toBe('allowed');
    // /proc/uptime exists only on Linux; on a Mac the allow-list entry is
    // inert and the read fails for the file's absence, never for permission.
    expect(out.read_uptime === 'allowed' || out.read_uptime === 'ENOENT').toBe(true);
    expect(out.listen).toBe('allowed');
  });

  test('both boot paths run the worker under the same flags', () => {
    // The cold entrypoint is rendered from piWorkerNodeArgs; the park script is
    // a standalone file and spells the flags out. Pin them to each other so a
    // change to one cannot leave the other boot path unconfined.
    const park = piWorkerParkScriptForTest();
    const bootSpawn = park.slice(park.indexOf('async function boot('), park.indexOf('function validClaimEnv('));
    expect(bootSpawn).toContain("'--permission'");
    expect(bootSpawn).toContain("'--allow-fs-read=' + RUNTIME_DIR + '/session-worker.mjs'");
    expect(bootSpawn).toContain("'--allow-fs-read=/proc/uptime'");
    // fetch-runtime.mjs must NOT run confined: it writes the artifact.
    const fetchSpawn = bootSpawn.slice(0, bootSpawn.indexOf('const worker = spawn('));
    expect(fetchSpawn).toContain("spawn('node', [RUNTIME_DIR + '/fetch-runtime.mjs']");
    expect(piWorkerNodeArgs('/opt/kortix')).toEqual([
      '--permission',
      '--allow-fs-read=/opt/kortix/session-worker.mjs',
      '--allow-fs-read=/proc/uptime',
    ]);
  });
});

describe.skipIf(!existsSync(WORKER_DIST))('pi worker lockdown — the real bundle under the permission model', () => {
  test('boots, serves health, and completes a tool turn whose every operation crosses into the environment', async () => {
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = WORKER_DIST;
    const bundle = await getPiWorkerBundle();
    const artifact = compilePiRuntime({
      projectId: 'project-lockdown',
      ref: 'main',
      sourceSha: 'd'.repeat(40),
      agentConfig: JSON.stringify({ agent: { dev: { prompt: 'You are the locked-down dev agent.' } } }),
      defaultAgent: 'dev',
      workerBundle: bundle.source,
    });
    const dir = await runtimeDir();
    const runtimePath = join(dir, 'session-worker.mjs');
    await writeFile(runtimePath, artifact.source, { mode: 0o500 });

    // A stand-in environment that records every crossing and writes nothing.
    const ops: string[] = [];
    const env = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { op } = JSON.parse(body || '{}') as { op?: string };
        ops.push(op ?? '?');
        const value =
          op === 'exec'
            ? { stdout: 'ran in the environment', stderr: '', exitCode: 0 }
            : op === 'exists'
              ? false
              : op === 'listDir'
                ? []
                : op === 'fileInfo'
                  ? null
                  : '/workspace/ok';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, value }));
      });
    });
    servers.push(env);
    await new Promise<void>((r) => env.listen(0, '127.0.0.1', () => r()));
    const envPort = (env.address() as { port: number }).port;

    const port = 19400 + Math.floor(Math.random() * 500);
    const TOKEN = 'lockdown-token';
    const child = spawn('node', [...piWorkerNodeArgs(dir), runtimePath], {
      env: {
        ...process.env,
        PORT: String(port),
        KORTIX_MODEL_MODE: 'faux',
        KORTIX_PROJECT_ID: 'project-lockdown',
        KORTIX_TOKEN: TOKEN,
        KORTIX_ENV_URL: `http://127.0.0.1:${envPort}`,
        KORTIX_ENV_TRANSPORT: 'fetch',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));

    const base = `http://127.0.0.1:${port}`;
    const health = await waitFor(`${base}/health`);
    expect(health, `worker never listened under --permission; stderr: ${stderr.slice(0, 800)}`).not.toBeNull();
    const healthBody = (await health!.json()) as { ok?: boolean; environment?: { mode?: string } };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.environment?.mode).toBe('url');

    // A scripted faux turn: one bash call, one write, then an answer. Every
    // operation must land in the stand-in environment; the worker's own tree
    // is unwritable, so a local fallback would surface as a tool error.
    const turn = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'probe',
        script: [
          { tool: 'bash', args: { command: 'echo hi > escaped.txt' } },
          { tool: 'write', args: { path: '/workspace/agent-wrote-this.txt', content: 'payload' } },
          { text: 'done' },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(turn.status).toBe(200);
    const result = (await turn.json()) as { ok?: boolean; rpcCalls?: string[] };
    expect(result.ok).toBe(true);
    expect(result.rpcCalls).toContain('exec');
    expect(result.rpcCalls).toContain('writeFile');
    expect(ops).toContain('exec');
    expect(ops).toContain('writeFile');
    // Still alive, still confined: no permission error reached stderr as a
    // crash, and the process did not exit.
    expect(child.exitCode).toBeNull();
    expect(stderr).not.toMatch(/ERR_ACCESS_DENIED/);
  }, 30_000);
});
