import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sessions-missing-project-'));
let responseStatus = 404;
const server = Bun.serve({ port: 0, fetch: () => Response.json(
  responseStatus === 200 ? [] : { error: 'Not found' }, { status: responseStatus },
) });
writeFileSync(join(root, 'config.json'), JSON.stringify({ active: 'test', hosts: {
  test: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token',
    default_project: { project_id: 'synthetic-project', account_id: 'synthetic-account', name: 'Synthetic project' },
  },
} }));
afterEach(() => { responseStatus = 404; });
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });

async function run(extra: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env, KORTIX_CONFIG_FILE: join(root, 'config.json'),
    KORTIX_NO_UPDATE_CHECK: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', NO_COLOR: '1' };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'BASH_ENV']) delete env[key];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts'),
    'sessions', 'ls', '--host', 'test', ...extra], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test('a missing default project explains the recovery command', async () => {
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Default project');
  expect(result.stderr).toContain('not found');
  expect(result.stderr).toContain('kortix projects use <id> --host test');
});

test('an explicit project is not called the default', async () => {
  const result = await run(['--project', 'explicit-project']);
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain('Default project');
  expect(result.stderr).toContain('Not found');
});

test('other errors retain their meaning', async () => {
  responseStatus = 500;
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain('Default project');
});

test('a valid default keeps the empty-list output', async () => {
  responseStatus = 200;
  const result = await run();
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('No sessions in your list');
});

 test('a directory link is not called the default project', async () => {
  mkdirSync(join(root, '.kortix'));
  writeFileSync(join(root, '.kortix/link.json'), JSON.stringify({
    project_id: 'linked-project', host: 'test', account_id: 'synthetic-account',
  }));
  try {
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('Default project');
  } finally { rmSync(join(root, '.kortix'), { recursive: true }); }
});
