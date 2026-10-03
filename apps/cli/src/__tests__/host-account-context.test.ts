import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAccountContext } from '../command-helpers.ts';

const keys = ['KORTIX_CONFIG_FILE', 'KORTIX_AUTH_FILE', 'KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_DISABLE_SANDBOX_ENV_FILE'] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;

function configure(otherAccount = 'other-account', otherToken = 'synthetic-other-token', url = 'http://localhost:18008') {
  const host = (account_id: string, token: string) => ({
    url, token, account_id,
    user_id: 'synthetic-user', user_email: 'test@example.test', logged_in_at: '2026-01-01T00:00:00Z',
  });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    active: 'home', hosts: {
      home: host('home-account', 'synthetic-home-token'),
      other: host(otherAccount, otherToken),
    },
  }));
}

beforeEach(() => {
  for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; }
  dir = mkdtempSync(join(tmpdir(), 'kortix-account-context-'));
  process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  configure();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('explicit host uses that host account and credentials', () => {
  const ctx = resolveAccountContext({ hostArg: 'other' });
  expect(ctx?.accountId).toBe('other-account');
  expect(ctx?.auth.token).toBe('synthetic-other-token');
});
test('explicit account overrides the named host default', () => {
  expect(resolveAccountContext({ hostArg: 'other', accountArg: 'pinned-account' })?.accountId).toBe('pinned-account');
});
test('without a host override the active account remains the default', () => {
  expect(resolveAccountContext()?.accountId).toBe('home-account');
});
test('a named host without an account cannot borrow the active host account', () => {
  configure('');
  expect(resolveAccountContext({ hostArg: 'other' })).toBeNull();
});
test('optional account stays empty on a named host without an account', () => {
  configure('');
  expect(resolveAccountContext({ hostArg: 'other', accountOptional: true })?.accountId).toBe('');
});
test('missing credentials do not fall back to the active host', () => {
  configure('other-account', '');
  expect(resolveAccountContext({ hostArg: 'other' })).toBeNull();
  expect(resolveAccountContext({ hostArg: 'unknown' })).toBeNull();
});

test('real permissions and audit CLI processes send the named host account', async () => {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return Response.json(request.url.includes('/audit') ? { events: [], next_cursor: null } : { permissions: [] });
  } });
  configure('other-account', 'synthetic-other-token', `http://127.0.0.1:${server.port}`);
  try {
    for (const command of ['permissions', 'audit']) {
      const child = Bun.spawn([process.execPath, new URL('../index.ts', import.meta.url).pathname, command, 'ls', '--host', 'other', '--json'], {
        env: { ...process.env, KORTIX_NO_UPDATE_CHECK: '1' }, stdout: 'pipe', stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual(command === 'audit' ? { events: [], next_cursor: null } : { permissions: [] });
    }
    expect(requests).toHaveLength(2);
    expect(requests.every(path => path.includes('/accounts/other-account/'))).toBe(true);
  } finally { server.stop(true); }
});
