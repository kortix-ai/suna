import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(corrupt = false) {
  const root = await mkdtemp(join(tmpdir(), 'environment-bootstrap-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'workspace', 'working-file.txt'), 'preserve uncommitted work\n');
  const listener = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = listener.port!;
  listener.stop(true);
  const agent = `import http.server,json,os
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'runtimeReady':True,'workload':os.environ['KORTIX_WORKLOAD'],'opencode':'disabled' if os.environ['KORTIX_WORKLOAD']=='environment' else 'ok','pid':os.getpid()}).encode())
 def log_message(self,*args): pass
http.server.HTTPServer(('127.0.0.1',int(os.environ['KORTIX_SERVICE_PORT'])),Handler).serve_forever()
`;
  const entrypoint = '#!/bin/sh\nexec python3 "$KORTIX_AGENT_BIN"\n';
  const assets: Record<string, string> = { agent, entrypoint };
  let downloads = 0;
  const api = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get('Authorization') !== 'Bearer test-environment-token') return new Response('unauthorized', { status: 401 });
      const path = new URL(request.url).pathname;
      if (path.endsWith('/manifest')) return Response.json({ components: Object.fromEntries(Object.entries(assets).map(([name, body]) => [name, { path: `/v1/runtime-assets/${name}`, sha256: corrupt && name === 'entrypoint' ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex') }])) });
      const name = path.split('/').at(-1)!;
      downloads++;
      return new Response(assets[name] ?? '', { status: assets[name] ? 200 : 404 });
    },
  });
  cleanups.push(() => api.stop(true));
  const env = {
    ...process.env, KORTIX_SERVICE_PORT: String(port), KORTIX_WORKLOAD: 'session',
    KORTIX_TOKEN: 'test-environment-token', KORTIX_API_URL: api.url.origin,
  };
  const oldPath = join(root, 'usr/local/bin/kortix-agent');
  await mkdir(join(root, 'usr/local/bin'), { recursive: true });
  await writeFile(oldPath, agent);
  const old = Bun.spawn(['python3', oldPath], { env, stdout: 'ignore', stderr: 'ignore' });
  cleanups.push(async () => { old.kill(); await old.exited; });
  await mkdir(join(root, 'proc', String(old.pid)), { recursive: true });
  await writeFile(join(root, 'proc', String(old.pid), 'cmdline'), `python3\0${oldPath}\0`);
  const health = async () => fetch(`http://127.0.0.1:${port}/kortix/health`).then((r) => r.json()) as Promise<{ workload: string; pid: number }>;
  for (let i = 0; i < 100; i++) {
    try { await health(); break; } catch { await Bun.sleep(20); }
  }
  cleanups.push(async () => {
    try { const current = await health(); if (current.pid !== old.pid) process.kill(current.pid, 'SIGTERM'); } catch {}
  });
  const run = async () => {
    const child = Bun.spawn(['python3', new URL('./environment-runtime-bootstrap.py', import.meta.url).pathname, root], { env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stderr, report: JSON.parse(stdout.trim().split('\n').at(-1)!) };
  };
  return { root, run, health, downloads: () => downloads, old };
}

describe('environment daemon bootstrap through the provider process contract', () => {
  test('replaces the legacy daemon, keeps working files, and becomes idempotent', async () => {
    const f = await fixture();
    expect(await f.health()).toMatchObject({ workload: 'session' });
    const first = await f.run();
    expect(first).toMatchObject({ code: 0, stderr: '', report: { ready: true, changed: true } });
    expect(await f.health()).toMatchObject({ workload: 'environment' });
    expect(await readFile(join(f.root, 'workspace/working-file.txt'), 'utf8')).toBe('preserve uncommitted work\n');
    expect(await readFile(join(f.root, 'opt/kortix/workload'), 'utf8')).toBe('environment\n');
    expect(f.downloads()).toBe(2);
    expect(await f.run()).toMatchObject({ code: 0, report: { ready: true, changed: false } });
    expect(f.downloads()).toBe(2);
  }, 15000);

  test('a corrupt artifact leaves the existing daemon and working files intact', async () => {
    const f = await fixture(true);
    expect(await f.run()).toMatchObject({ code: 1, report: { ready: false, error: 'entrypoint digest mismatch' } });
    expect(await f.health()).toMatchObject({ workload: 'session', pid: f.old.pid });
    expect(await readFile(join(f.root, 'workspace/working-file.txt'), 'utf8')).toBe('preserve uncommitted work\n');
  }, 15000);
});
