import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirs: string[] = [];
const token = 'kortix_pat_identity_fixture';
const account = 'aaaaaaaa-1111-4111-8111-111111111111';
const project = {
  project_id: 'bbbbbbbb-1111-4111-8111-111111111111',
  name: 'fixture-project',
  account_id: account,
};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (req.headers.get('authorization') !== `Bearer ${token}`)
      return Response.json({}, { status: 401 });
    return Response.json({
      user_id: 'fixture-user',
      email: 'owner@example.test',
      accounts: [{ account_id: account, slug: 'fixture', name: 'Fixture', role: 'owner' }],
    });
  },
});
const url = `http://127.0.0.1:${server.port}/v1`;

async function cli(args: string[], delegated = false, aliases = false) {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-identity-'));
  dirs.push(dir);
  const config = join(dir, 'config.json');
  const host = {
    url,
    token: delegated ? '' : token,
    user_id: 'fixture-user',
    user_email: '',
    account_id: account,
    logged_in_at: '',
    default_project: project,
  };
  writeFileSync(
    config,
    JSON.stringify({
      active: 'stored',
      ...(aliases ? { sandbox_selected: 'stored' } : {}),
      hosts: { stored: host, ...(aliases ? { second: { ...host, token } } : {}) },
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
  };
  for (const key of [
    'KORTIX_TOKEN',
    'KORTIX_API_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_SESSION_ID',
    'BASH_ENV',
  ])
    delete env[key];
  if (delegated) Object.assign(env, { KORTIX_TOKEN: token, KORTIX_API_URL: url });
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), ...args], {
    cwd: dir,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
afterAll(() => {
  server.stop(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('whoami pairs delegated host name with the actual API URL', async () => {
  const result = await cli(['whoami', '--json'], true);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ host: 'sandbox', url });
});
test('whoami exposes the explicitly named host default project', async () => {
  const result = await cli(['whoami', '--host', 'stored', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).default_project).toEqual(project);
});
test('hosts ls distinguishes effective delegated authentication from stored credentials', async () => {
  const result = await cli(['hosts', 'ls', '--json'], true);
  expect(result.code).toBe(0);
  const rows = JSON.parse(result.stdout);
  expect(rows.find((row: { active: boolean }) => row.active)).toMatchObject({
    name: 'sandbox',
    url,
    logged_in: true,
    credential_source: 'environment',
  });
  expect(rows.find((row: { name: string }) => row.name === 'stored')).toMatchObject({
    active: false,
    logged_in: false,
  });
  expect(result.stdout).not.toContain(token);
});
test('--debug reports actual request identity on stderr without changing JSON stdout or exposing tokens', async () => {
  const result = await cli(['whoami', '--json', '--debug'], true);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).host).toBe('sandbox');
  expect(result.stderr).toContain('[kortix-debug]');
  expect(result.stderr).toContain('environment');
  expect(result.stderr).toContain('sandbox');
  expect(result.stderr).toContain(url);
  expect(result.stdout + result.stderr).not.toContain(token);
});

test('debug covers local commands and explicit aliases without guessing from credentials', async () => {
  const local = await cli(['--debug', 'hosts', 'ls', '--json'], true);
  expect(local.code).toBe(0);
  expect(local.stderr).toContain('environment');
  const named = await cli(['whoami', '--host', 'second', '--json', '--debug'], false, true);
  expect(named.code).toBe(0);
  expect(JSON.parse(named.stdout).host).toBe('second');
  expect(named.stderr).toContain('"host":"second"');
  expect(named.stderr).toContain('"credential_source":"stored"');
  expect(named.stderr).not.toContain(token);
});

test('hosts ls marks the in-sandbox selected stored host as the effective identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-identity-'));
  dirs.push(dir);
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      active: 'stored',
      sandbox_selected: 'stored',
      hosts: {
        stored: {
          url,
          token,
          user_id: 'fixture-user',
          user_email: '',
          account_id: account,
          logged_in_at: '',
        },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    KORTIX_TOKEN: token,
    KORTIX_API_URL: url,
  };
  for (const key of ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'BASH_ENV']) delete env[key];
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, '../index.ts'), 'hosts', 'ls', '--json'],
    { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  const rows = JSON.parse(stdout);
  expect(rows.find((row: { active: boolean }) => row.active)).toMatchObject({
    name: 'stored',
    url,
    credential_source: 'stored',
  });
  expect(rows.some((row: { name: string }) => row.name === 'env' || row.name === 'sandbox')).toBe(
    false,
  );
});

test('hosts ls reports a url-only environment override as a synthetic env row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-identity-'));
  dirs.push(dir);
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      active: 'stored',
      hosts: {
        stored: {
          url,
          token,
          user_id: 'fixture-user',
          user_email: '',
          account_id: account,
          logged_in_at: '',
        },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    KORTIX_API_URL: 'http://127.0.0.1:9/v1',
  };
  for (const key of ['KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'BASH_ENV'])
    delete env[key];
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, '../index.ts'), 'hosts', 'ls', '--json'],
    { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  const rows = JSON.parse(stdout);
  expect(rows.find((row: { active: boolean }) => row.active)).toMatchObject({
    name: 'env',
    url: 'http://127.0.0.1:9/v1',
    credential_source: 'url-override',
  });
  expect(rows.find((row: { name: string }) => row.name === 'stored')).toMatchObject({
    active: false,
  });
});

test('a leading --debug is intercepted and sets the debug trace', async () => {
  const intercepted = await cli(['--debug', 'whoami', '--json'], true);
  expect(intercepted.code).toBe(0);
  expect(intercepted.stderr).toContain('[kortix-debug]');
});

test('an unparseable stored url degrades the debug trace instead of killing the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-identity-'));
  dirs.push(dir);
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      active: 'broken',
      hosts: {
        broken: {
          url: 'not-a-url',
          token,
          user_id: 'fixture-user',
          user_email: '',
          account_id: account,
          logged_in_at: '',
        },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    KORTIX_DEBUG: '1',
  };
  for (const key of [
    'KORTIX_TOKEN',
    'KORTIX_API_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_SESSION_ID',
    'BASH_ENV',
  ])
    delete env[key];
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, '../index.ts'), 'hosts', 'current'],
    { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stdout).toContain('broken');
  expect(stderr).toContain('[kortix-debug]');
  expect(stderr).toContain('not-a-url');
});
