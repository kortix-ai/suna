/**
 * THE architectural invariant: the agent has no reachable path to the worker's
 * own filesystem.
 *
 * This is the whole point of the harness/environment split. From the design
 * huddle that started it: "worker must be locked down to prevent custom tools
 * from accessing local filesystem; all tools default to the Kortix SDK pointing
 * to the sandbox", with state corruption named as the failure mode — the worker
 * is a shared, long-lived, read-only-by-intent box, and a tool that writes to it
 * corrupts every session that box goes on to serve.
 *
 * `spikes/pi-worker/test/proof.ts` proved this for the SPIKE. The spike
 * deliberately never touched `apps/`, so until this file the shipped worker had
 * no test of it at all — `kortix-env.test.ts` covers only errno mapping and
 * timeout conversion, both pure functions.
 *
 * READ THE SECOND ASSERTION, NOT THE FIRST. "The operation succeeded" proves
 * nothing. "The operation succeeded AND the worker's disk is byte-for-byte
 * unchanged" is the claim. A run that does both the right thing and a local
 * write is a FAILURE — that is precisely how the split silently collapses back
 * into a single box, with every test still green.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { KortixExecutionEnv } from './kortix-env.ts';
import { LazyKortixEnv } from './lazy-env.ts';

/** Recursive (path, size, mtime) fingerprint — the spike's disk snapshot. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`d ${relative(root, abs)}`);
        walk(abs);
      } else {
        const st = statSync(abs);
        out.push(`f ${relative(root, abs)} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** A sentinel tree standing in for the worker's own disk. */
function workerDisk(): string {
  const root = mkdtempSync(join(tmpdir(), 'kortix-worker-disk-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'pre-existing.txt'), 'untouched', 'utf8');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A stand-in environment that records every crossing and writes nothing. */
async function fakeEnvironment(): Promise<{ url: string; ops: string[] }> {
  const ops: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { op } = JSON.parse(body || '{}') as { op?: string };
      ops.push(op ?? '?');
      const value =
        op === 'exists'
          ? true
          : op === 'readTextFile'
            ? 'from the environment, never from disk'
            : op === 'exec'
              ? { stdout: 'ran in the environment', stderr: '', exitCode: 0 }
              : op === 'listDir'
                ? []
                : '/workspace/ok';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => server.close());
  return { url: `http://127.0.0.1:${port}`, ops };
}

describe('harness/environment isolation', () => {
  test('every file and shell operation crosses the RPC boundary, and the worker disk is byte-for-byte unchanged', async () => {
    const disk = workerDisk();
    const before = snapshot(disk);
    const { url, ops } = await fakeEnvironment();

    // cwd points INSIDE the sentinel: a local implementation would land here.
    const env = new KortixExecutionEnv({
      baseUrl: url,
      cwd: join(disk, 'workspace'),
      transport: 'fetch',
    });

    const wrote = await env.writeFile(join(disk, 'workspace', 'agent-wrote-this.txt'), 'payload');
    const read = await env.readTextFile(join(disk, 'workspace', 'pre-existing.txt'));
    const ran = await env.exec('echo hello > escaped.txt');
    const made = await env.createDir(join(disk, 'workspace', 'agent-made-this'));
    const gone = await env.remove(join(disk, 'workspace', 'pre-existing.txt'));

    // 1. The operations were served — the agent is not merely erroring out.
    for (const r of [wrote, read, ran, made, gone]) expect(r.ok).toBe(true);
    expect((read as { value: string }).value).toBe('from the environment, never from disk');

    // 2. Each one actually crossed the wire.
    expect(ops).toEqual(['writeFile', 'readTextFile', 'exec', 'createDir', 'remove']);
    expect(env.calls.map((c) => c.op)).toEqual(ops);

    // 3. THE CLAIM. A write, a mkdir and a delete were all dispatched at paths
    //    inside this tree, and none of them happened here.
    expect(snapshot(disk)).toEqual(before);
  });

  test('a worker that cannot reach its environment fails the tool — it never falls back to local execution', async () => {
    const disk = workerDisk();
    const before = snapshot(disk);

    // Port 1 is closed: `ensure` can never succeed, so the environment is
    // permanently unattachable — the state a provisioning failure leaves.
    const env = new LazyKortixEnv({
      apiUrl: 'http://127.0.0.1:1/v1',
      token: 'session-token',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      cwd: join(disk, 'workspace'),
      ensureTimeoutMs: 50,
    });

    const wrote = await env.writeFile(join(disk, 'workspace', 'fallback.txt'), 'must not land');
    const ran = await env.exec('touch fallback-shell.txt');
    const read = await env.readTextFile(join(disk, 'workspace', 'pre-existing.txt'));

    // The tool gets an error it can render. It does NOT get the worker's disk.
    for (const r of [wrote, ran, read]) {
      expect(r.ok).toBe(false);
      expect(String((r as { error: unknown }).error)).toContain('environment');
    }
    expect(env.attached).toBe(false);

    // The degraded path is where a local fallback would be most tempting, and
    // most damaging: it would write to the shared worker instead of failing.
    expect(snapshot(disk)).toEqual(before);
    // Three operations, each re-attempting the attach it is not allowed to
    // cache (a failed attach must not poison later tool calls), and the retry
    // loop sleeps 2s per attempt — so this is ~6s by construction, not a hang.
  }, 30_000);
});
