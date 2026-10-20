import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectId = '00000000-0000-4000-a000-000000000111';
const entry = resolve(import.meta.dir, '../index.ts');
const root = mkdtempSync(join(tmpdir(), 'sessions-missing-project-'));
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
});

for (const json of [false, true]) {
  test(`missing default project gives a recovery hint${json ? ' with --json' : ''}`, async () => {
    const result = await run(404, json);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Default project "${projectId}" was not found`);
    expect(result.stderr).toContain('kortix projects use <id>');
    expect(result.stderr).toContain('kortix projects ls');
  });
}

test('permission failures keep the server explanation', async () => {
  const result = await run(403);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Permission denied');
  expect(result.stderr).not.toContain('was not found');
});

async function run(status: number, json = false) {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/accounts/me') return Response.json({ accounts: [] });
      expect(new URL(request.url).pathname).toBe(`/v1/projects/${projectId}/sessions`);
      return Response.json({ error: status === 404 ? 'Not found' : 'Permission denied' }, { status });
    },
  });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ active: 'test', hosts: { test: {
    url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token',
    default_project: { project_id: projectId, account_id: 'synthetic-account', name: 'Deleted project' },
  } } }));
  const env: Record<string, string | undefined> = { ...process.env, KORTIX_CONFIG_FILE: config, KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', NO_COLOR: '1' };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'BASH_ENV']) delete env[key];
  const child = Bun.spawn([process.execPath, entry, 'sessions', 'ls', ...(json ? ['--json'] : [])], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));
