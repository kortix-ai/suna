import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi, writeConfig, type FakeApi } from './support/account-cli-harness.ts';

let tmp: string;
let named: FakeApi;
let delegated: FakeApi;
let configFile: string;
const accounts = [
  { account_id: 'account_1', slug: 'acct', name: 'Acct', role: 'owner' },
  { account_id: 'account_2', slug: 'second', name: 'Second', role: 'owner' },
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'accounts-host-'));
  named = startFakeApi((req) => {
    expect(req.headers.get('authorization')).toBe('Bearer tok_test');
    return Response.json({ accounts });
  });
  delegated = startFakeApi(() => Response.json({ accounts: [] }));
  configFile = writeConfig(tmp, named.url);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.hosts.other = { ...config.hosts.test, account_id: 'other_account', default_project: { project_id: 'other_project', account_id: 'other_account' } };
  config.hosts.test.default_project = { project_id: 'named_project', account_id: 'account_1' };
  config.active = 'other';
  writeFileSync(configFile, JSON.stringify(config));
});
afterEach(() => {
  named.stop();
  delegated.stop();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts'), 'accounts', ...args], {
    cwd: tmp,
    env: { ...process.env, HOME: tmp, KORTIX_CONFIG_FILE: configFile, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_TOKEN: 'delegated-token', KORTIX_API_URL: delegated.url, KORTIX_NO_UPDATE_CHECK: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

test('accounts ls explicit host overrides delegation origin and token', async () => {
  const result = await run(['ls', '--host', 'test', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(accounts.map(a => ({ ...a, active: a.account_id === 'account_1' })));
  expect(named.requests.map(r => r.path)).toEqual(['/v1/accounts/me']);
  expect(delegated.requests).toEqual([]);
});

test('current, info and use share named-host account state without changing the active host', async () => {
  const before = JSON.parse(readFileSync(configFile, 'utf8'));
  const current = await run(['current', '--host', 'test', '--json']);
  expect(current.code).toBe(0);
  expect(JSON.parse(current.stdout).account_id).toBe('account_1');
  expect(named.requests).toEqual([]);
  const info = await run(['info', '--host=test', '--json']);
  expect(info.code).toBe(0);
  expect(JSON.parse(info.stdout)).toEqual({ ...accounts[0], active: true });
  const use = await run(['use', '--host', 'test', 'second']);
  expect(use.code).toBe(0);
  const after = JSON.parse(readFileSync(configFile, 'utf8'));
  expect(after.active).toBe(before.active);
  expect(after.hosts.other).toEqual(before.hosts.other);
  expect(after.hosts.test.account_id).toBe('account_2');
  expect(after.hosts.test.account_slug).toBe('second');
  expect(after.hosts.test.account_name).toBe('Second');
  expect(after.hosts.test.default_project).toBeUndefined();
  expect(delegated.requests).toEqual([]);
});

test('unknown, tokenless, missing and empty explicit hosts never fall back to delegation', async () => {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.hosts.tokenless = { ...config.hosts.test, token: '' };
  writeFileSync(configFile, JSON.stringify(config));
  const before = readFileSync(configFile, 'utf8');
  for (const args of [['--host', 'unknown'], ['--host', 'tokenless'], ['--host'], ['--host=']]) {
    const result = await run(['ls', '--json', ...args]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Not logged in|requires a value|Missing value/);
  }
  expect(named.requests).toEqual([]);
  expect(delegated.requests).toEqual([]);
  expect(readFileSync(configFile, 'utf8')).toBe(before);
});

test('omitting host preserves delegated identity precedence', async () => {
  const result = await run(['ls', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(named.requests).toEqual([]);
  expect(delegated.requests.map(r => r.path)).toEqual(['/v1/accounts/me']);
});
