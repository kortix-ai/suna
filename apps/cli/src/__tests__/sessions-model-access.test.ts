import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve(import.meta.dir, '../index.ts');
const project = '00000000-0000-4000-a000-000000000111';
const session = '11111111-1111-4111-8111-111111111111';
let root = '';
let server: ReturnType<typeof Bun.serve>;
let requests: string[];
let models: Record<string, unknown>;
let catalogStatus: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-model-access-'));
  requests = [];
  models = {};
  catalogStatus = 200;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path.endsWith('/model-picker')) {
        return Response.json(catalogStatus === 200 ? { models } : { error: 'Unavailable' }, { status: catalogStatus });
      }
      if (path === `/v1/projects/${project}/sessions/${session}`) {
        return Response.json({ session_id: session, project_id: project, status: 'running', metadata: {} });
      }
      if (path === `/v1/projects/${project}/sessions`) {
        if (request.method === 'GET') return Response.json([]);
        return Response.json({ error: 'create reached' }, { status: 409 });
      }
      if (path === `/v1/projects/${project}`) {
        return Response.json({ project_id: project, metadata: { git: { managed: true } } });
      }
      return Response.json({ error: 'runtime reached' }, { status: 409 });
    },
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    active: 'test',
    hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token', account_id: 'synthetic-account' } },
  }));
});

afterEach(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function run(args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, KORTIX_CONFIG_FILE: join(root, 'config.json'), KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1' };
  for (const key of ['KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_PROJECT_ID', 'BASH_ENV']) delete env[key];
  const child = Bun.spawn([process.execPath, entry, 'sessions', ...args, '--host', 'test', '--project', project], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

for (const args of [
  ['new', '--prompt', 'Reply pong', '--wait', '--json'],
  ['chat', '--new', '--prompt', 'Reply pong', '--json'],
  ['chat', session, '--prompt', 'Reply ping'],
  ['chat', session, '--prompt', 'Reply ping', '--queue'],
  ['chat', session, '--prompt', 'Reply ping', '--steer'],
]) {
  test(`${args.join(' ')} refuses an empty model catalog before creating or waking a sandbox`, async () => {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No model connected — connect one to start chatting');
    expect(result.stdout).toBe('');
    expect(requests.filter((request) => !request.startsWith('GET '))).toEqual([]);
  });
}

test('a connected model allows session creation even when hidden from the picker', async () => {
  models = { 'synthetic/model': { enabled: false } };
  const result = await run(['new', '--prompt', 'Reply pong', '--json']);
  expect(result.stderr).toContain('create reached');
  expect(requests).toContain(`POST /v1/projects/${project}/sessions`);
});

test('native-provider projects without the gateway keep session creation', async () => {
  catalogStatus = 404;
  const result = await run(['new', '--prompt', 'Reply pong', '--model', 'synthetic/model']);
  expect(result.stderr).toContain('create reached');
  expect(requests).toContain(`POST /v1/projects/${project}/sessions`);
});

test('catalog failures are reported, not treated as native-provider projects', async () => {
  catalogStatus = 503;
  const result = await run(['new', '--prompt', 'Reply pong']);
  expect(result.code).toBe(1);
  expect(requests.filter((request) => request.startsWith('POST '))).toEqual([]);
});
