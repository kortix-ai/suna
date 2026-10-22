import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// KRTX-2822: `marketplace show <name>` resolved a short name, while `install
// <name>` sent it to the server as an id ("Unknown item"). Install resolves a
// short name the same way, refuses an ambiguous one, and sends the full id.

const CATALOG = [
  { id: 'kortix-starter:pdf', registry: 'kortix-starter', name: 'pdf', type: 'registry:skill', title: 'PDF', description: null },
  { id: 'kortix-starter:pdf-tools', registry: 'kortix-starter', name: 'pdf-tools', type: 'registry:skill', title: 'PDF tools', description: null },
  { id: 'acme/plugins:review', registry: 'acme/plugins', name: 'review', type: 'registry:skill', title: 'Review', description: null },
  { id: 'other/plugins:review', registry: 'other/plugins', name: 'review', type: 'registry:skill', title: 'Review', description: null },
];

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let calls: Array<{ method: string; path: string; query: string | null; body: unknown }>;

beforeEach(() => {
  calls = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams.get('query'), body });
      if (url.pathname.endsWith('/marketplace/items')) {
        const q = url.searchParams.get('query') ?? '';
        return Response.json({ items: CATALOG.filter((i) => i.id.includes(q)) });
      }
      if (url.pathname.includes('/marketplace/items/')) return Response.json({ error: 'Unknown item' }, { status: 404 });
      if (url.pathname.endsWith('/install-session')) return Response.json({ session_id: 'session-install' });
      // The install session fails at once: these tests pin only the id sent.
      return Response.json({ status: 'failed', error: 'synthetic stop' });
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'marketplace-install-name-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ active: 'test', hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic', account_id: 'account-test' } } }),
  );
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function install(item: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: dir, KORTIX_CONFIG_FILE: join(dir, 'config.json'), KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1' };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'BASH_ENV']) delete env[key];
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'marketplace', 'install', item, '--project', 'project-test', '--json', '--timeout', '5'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

const installPosts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/install-session'));

test('a short name installs the one item it names, by its full id', async () => {
  const r = await install('pdf');
  expect(installPosts().map((c) => c.body)).toEqual([{ id: 'kortix-starter:pdf' }]);
  expect(JSON.parse(r.stdout)).toMatchObject({ item_id: 'kortix-starter:pdf', session_id: 'session-install' });
  expect(r.stderr).not.toContain('Unknown item');
});

test('a short name two registries share is refused with both ids, before any install', async () => {
  const r = await install('review');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('acme/plugins:review');
  expect(r.stderr).toContain('other/plugins:review');
  expect(installPosts()).toEqual([]);
});

test('a short name that matches nothing fails before any install and names the search command', async () => {
  const r = await install('nothing-here');
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('No marketplace item matches "nothing-here"');
  expect(r.stderr).toContain('kortix marketplace search');
  expect(installPosts()).toEqual([]);
});

test('a full id is sent as given, with no catalog lookup', async () => {
  await install('kortix-starter:pdf');
  expect(installPosts().map((c) => c.body)).toEqual([{ id: 'kortix-starter:pdf' }]);
  expect(calls.some((c) => c.path.endsWith('/marketplace/items'))).toBe(false);
});
