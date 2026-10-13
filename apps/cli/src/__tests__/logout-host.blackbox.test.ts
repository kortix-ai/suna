import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let api: ReturnType<typeof Bun.serve>;
let requests: string[];

async function cli(...args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, '../index.ts'), ...args],
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '', HOME: dir, NO_COLOR: '1',
      KORTIX_NO_UPDATE_CHECK: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_CONFIG_FILE: join(dir, 'config.json'),
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-logout-'));
  requests = [];
  api = Bun.serve({ port: 0, fetch(req) {
    requests.push(new URL(req.url).pathname);
    return Response.json({ user_id: 'user_test', email: 'agent@example.test',
      accounts: [{ account_id: 'acct_test', slug: 'test', name: 'Test', role: 'owner' }] });
  } });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ active: 'custom', hosts: {
    custom: { url: api.url.origin, dashboard_url: 'http://localhost:3000',
      token: 'kortix_pat_test', user_id: 'user_test', user_email: 'agent@example.test',
      account_id: 'acct_test', logged_in_at: '2026-01-01T00:00:00Z' },
  } }));
});

afterEach(() => { api.stop(true); rmSync(dir, { recursive: true, force: true }); });

for (const name of ['custom', 'default', 'selfhost']) {
  for (const args of [['logout', '--host', name], ['hosts', 'logout', name], ['logout']]) {
    test(`${name}: ${args.join(' ')} preserves registration and recovery login deployment`, async () => {
      const seeded = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      seeded.hosts[name] = seeded.hosts.custom;
      if (name !== 'custom') delete seeded.hosts.custom;
      seeded.active = name;
      writeFileSync(join(dir, 'config.json'), JSON.stringify(seeded));
      expect((await cli(...args)).code).toBe(0);
      const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(config.active).toBe(name);
      expect(config.hosts[name]).toMatchObject({ url: api.url.origin,
        dashboard_url: 'http://localhost:3000', token: '' });
      const list = await cli('hosts', 'ls', '--json');
      expect(list.code).toBe(0);
      expect(JSON.parse(list.stdout)).toContainEqual(expect.objectContaining({
        name, url: api.url.origin, logged_in: false,
      }));
      const whoami = await cli('whoami', '--host', name);
      expect(whoami.code).toBe(1);
      expect(whoami.stderr).toContain(`kortix hosts login ${name}`);
      expect(requests).toEqual([]);
      const again = await cli(...args);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('already logged out');
      const login = await cli('hosts', 'login', name, '--token', 'kortix_pat_new', '--no-project');
      expect(login.code).toBe(0);
      expect(requests).toEqual(['/v1/accounts/me']);
      if (name !== 'selfhost') {
        expect((await cli('hosts', 'rm', name)).code).toBe(0);
        expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).hosts[name]).toBeUndefined();
      }
    });
  }
}
