import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `kortix spaces`, black-box: a real CLI process against a recording API.
// Inside a session the space defaults to the session's; every change is the
// existing space route, so the API's verdict (a 403 for a person without the
// right) reaches the agent as it is.

const PROJECT = 'cccccccc-3333-4333-8333-333333333333';
const SESSION = 'dddddddd-4444-4444-8444-444444444444';
const GENERAL = 'eeeeeeee-5555-4555-8555-555555555555';
const OTHER = 'ffffffff-6666-4666-8666-666666666666';
const ANA = '11111111-1111-4111-8111-111111111111';

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const calls: Call[] = [];
let tabs: Array<Record<string, unknown>> = [{ id: 'about', title: 'About', kind: 'file', ref: '/Company/Channels/general/about.md' }];
let forbidRename = false;
let chatOff = false;
let server: ReturnType<typeof Bun.serve>;
let dir = '';

const space = (id: string, slug: string) => ({
  space_id: id,
  kind: 'channel',
  slug,
  name: slug,
  description: null,
  is_default: id === GENERAL,
  dm_agent_name: null,
  can_edit: true,
  agents: [],
  tabs,
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname, body });
      const p = url.pathname.replace(/^\/v1/, '');
      if (p === `/workspaces/${PROJECT}`) return Response.json({ project_id: PROJECT, experimental_features: [{ key: 'chat', enabled: !chatOff }] });
      if (p === `/workspaces/${PROJECT}/spaces`) return Response.json({ spaces: [space(GENERAL, 'general'), space(OTHER, 'launch')] });
      if (p === `/workspaces/${PROJECT}/sessions/${SESSION}`) return Response.json({ session_id: SESSION, space_id: GENERAL });
      if (p === `/workspaces/${PROJECT}/access`) return Response.json({ members: [{ user_id: ANA, email: 'ana@example.test' }] });
      if (req.method === 'PATCH' && p.startsWith(`/workspaces/${PROJECT}/spaces/`)) {
        if (forbidRename) return Response.json({ error: 'Only the channel’s creator or a project manager can edit it.', code: 'forbidden' }, { status: 403 });
        const id = p.split('/').pop()!;
        return Response.json({ ...space(id, (body as { name?: string }).name?.toLowerCase() ?? 'general'), ...(body as object) });
      }
      if (req.method === 'PUT' && p.endsWith('/tabs')) {
        tabs = (body as { tabs: typeof tabs }).tabs;
        return Response.json(space(GENERAL, 'general'));
      }
      if (req.method === 'POST' && p.endsWith('/posts')) {
        const b = body as { thread_id?: string };
        return Response.json({ session_id: b.thread_id ?? 'new-thread', kind: b.thread_id ? 'reply' : 'thread', notified: [ANA], mentions: [{ token: 'ana', kind: 'person', label: 'Ana' }] }, { status: 201 });
      }
      if (p.endsWith('/members')) return Response.json({ members: [], implicit: false, can_add: true });
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'kortix-spaces-'));
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function kortix(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ active: 'test', hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic', account_id: 'account-test' } } }));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_SESSION_ID: SESSION,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'BASH_ENV']) delete env[key];
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'spaces', ...args, '--project', PROJECT], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

const writes = () => calls.filter((c) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.method));

test('rename and describe default to the session’s space and PATCH it', async () => {
  calls.length = 0;
  expect((await kortix('rename', 'Launch')).code).toBe(0);
  expect((await kortix('describe', 'Everything for the November launch')).code).toBe(0);
  expect(writes()).toEqual([
    { method: 'PATCH', path: `/v1/workspaces/${PROJECT}/spaces/${GENERAL}`, body: { name: 'Launch' } },
    { method: 'PATCH', path: `/v1/workspaces/${PROJECT}/spaces/${GENERAL}`, body: { description: 'Everything for the November launch' } },
  ]);
});

test('a named space wins over the session’s; agents set replaces the list', async () => {
  calls.length = 0;
  expect((await kortix('agents', '#launch', 'set', 'researcher', 'writer')).code).toBe(0);
  expect(writes()).toEqual([{ method: 'PATCH', path: `/v1/workspaces/${PROJECT}/spaces/${OTHER}`, body: { agents: ['researcher', 'writer'] } }]);
});

test('tabs add, move and rm send the whole new list; an unknown tab is refused before any write', async () => {
  calls.length = 0;
  expect((await kortix('tabs', 'add', 'file', 'Overview', '/Company/Channels/general/overview.md')).code).toBe(0);
  expect((await kortix('tabs', 'move', 'Overview', '1')).code).toBe(0);
  expect(tabs.map((t) => t.id)).toEqual(['overview', 'about']);
  expect((await kortix('tabs', 'rm', 'about')).code).toBe(0);
  expect(tabs).toEqual([{ id: 'overview', title: 'Overview', kind: 'file', ref: '/Company/Channels/general/overview.md' }]);
  const before = writes().length;
  const refused = await kortix('tabs', 'rm', 'nope');
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('No tab "nope" in this space.');
  expect(writes()).toHaveLength(before);
});

test('members add resolves an email through the project member list', async () => {
  calls.length = 0;
  expect((await kortix('members', 'add', 'ana@example.test')).code).toBe(0);
  expect(writes()).toEqual([{ method: 'POST', path: `/v1/workspaces/${PROJECT}/spaces/${GENERAL}/members`, body: { user_ids: [ANA] } }]);
});

test('the API’s 403 for a person without the right reaches the agent with its message', async () => {
  forbidRename = true;
  const result = await kortix('rename', 'Nope');
  forbidRename = false;
  expect(result.code).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain('Only the channel’s creator or a project manager can edit it.');
});

test('with Spaces (`chat`) off the command is refused before any space call', async () => {
  calls.length = 0;
  chatOff = true;
  const result = await kortix('rename', 'Launch');
  chatOff = false;
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('`chat` feature flag');
  expect(calls.filter((c) => c.path.includes('/spaces'))).toEqual([]);
});

test('post: a top-level message into the session’s space, a reply into a thread, --ask only with --thread', async () => {
  calls.length = 0;
  const top = await kortix('post', 'Weather check done. @ana');
  expect(top.code).toBe(0);
  expect(top.stdout).toContain('Mentioned Ana; 1 notified.');
  expect((await kortix('post', '#launch', 'Please approve', '--thread', SESSION, '--ask')).code).toBe(0);
  expect(writes()).toEqual([
    { method: 'POST', path: `/v1/workspaces/${PROJECT}/spaces/${GENERAL}/posts`, body: { text: 'Weather check done. @ana' } },
    { method: 'POST', path: `/v1/workspaces/${PROJECT}/spaces/${OTHER}/posts`, body: { text: 'Please approve', thread_id: SESSION, ask: true } },
  ]);
  const refused = await kortix('post', 'hi', '--ask');
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('--ask needs --thread');
});
