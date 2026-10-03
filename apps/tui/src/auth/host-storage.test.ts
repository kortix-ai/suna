import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHost, loadConfig, setActiveAccount, setDefaultProject, upsertHost } from '@kortix/cli/src/api/config.ts';
import * as sharedStore from '@kortix/shared/host-config';
import { loginToHost } from '../features/login/login-flow.ts';
import { resolveHost } from './hosts.ts';

const originalPath = process.env.KORTIX_CONFIG_FILE;
const dirs: string[] = [];
afterEach(() => {
  if (originalPath === undefined) delete process.env.KORTIX_CONFIG_FILE;
  else process.env.KORTIX_CONFIG_FILE = originalPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-storage-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  process.env.KORTIX_CONFIG_FILE = path;
  return path;
}

test('CLI writes and TUI login read back the same scratch store and account invariants', async () => {
  const path = scratchPath();
  writeFileSync(path, JSON.stringify({ active: 'scratch', hosts: {} }), { mode: 0o644 });
  upsertHost('scratch', {
    url: 'http://localhost:17408', token: 'synthetic-old-token', user_id: 'synthetic-user',
    user_email: 'synthetic@example.test', account_id: 'synthetic-account',
    dashboard_url: 'http://localhost:17400', logged_in_at: '2026-01-01T00:00:00.000Z',
  }, true);
  setDefaultProject({ project_id: 'synthetic-project', account_id: 'synthetic-account' });
  expect(resolveHost({})?.defaultProjectId).toBe('synthetic-project');
  expect(resolveHost({})?.token).toBe('synthetic-old-token');
  const result = await loginToHost({ name: 'scratch', url: 'http://localhost:17408/v1', token: 'synthetic-new-token' }, {
    validate: async () => ({ valid: true, identity: {
      user_id: 'synthetic-user', email: 'synthetic@example.test',
      accounts: [{ account_id: 'synthetic-account', slug: 'scratch', name: 'Scratch', role: 'owner' }],
    } }),
  });
  expect(result.ok).toBe(true);
  expect(getHost('scratch')?.token).toBe('synthetic-new-token');
  expect(getHost('scratch')?.dashboard_url).toBe('http://localhost:17400');
  expect(resolveHost({})?.defaultProjectId).toBe('synthetic-project');
  setActiveAccount({ id: 'synthetic-other-account' });
  expect(resolveHost({})?.defaultProjectId).toBeUndefined();
  expect(loadConfig().active).toBe('scratch');
  expect(sharedStore.getHost('scratch')).toEqual(getHost('scratch'));
  sharedStore.setActiveAccount({ id: 'synthetic-third-account' });
  expect(getHost('scratch')?.account_id).toBe('synthetic-third-account');
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  scratchPath();
  expect(getHost('scratch')).toBeNull();
});

for (const scenario of ['override-migration', 'default-migration', 'override-isolation']) {
  test(`legacy scratch HOME: ${scenario}`, () => {
    const custom = scratchPath();
    const home = join(custom, '..');
    const script = `
      import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
      import { join } from 'node:path';
      import { loadConfig } from './apps/cli/src/api/config.ts';
      import { resolveHost } from './apps/tui/src/auth/hosts.ts';
      const dir = join(process.env.HOME, '.config/kortix');
      mkdirSync(dir, { recursive: true });
      const legacy = join(dir, 'auth.json');
      const auth = { api_base: 'http://localhost:17408', token: 'synthetic-migration-token' };
      writeFileSync(legacy, JSON.stringify(auth));
      const scenario = process.env.HOST_STORAGE_SCENARIO;
      if (scenario === 'default-migration') delete process.env.KORTIX_CONFIG_FILE;
      if (scenario === 'override-migration') writeFileSync(process.env.KORTIX_CONFIG_FILE, JSON.stringify(auth), { mode: 0o644 });
      const config = loadConfig();
      const path = process.env.KORTIX_CONFIG_FILE ?? join(dir, 'config.json');
      console.log(JSON.stringify({ token: config.hosts.cloud?.token, tuiToken: resolveHost({})?.token,
        legacyExists: existsSync(legacy), mode: existsSync(path) ? statSync(path).mode & 0o777 : null }));
    `;
    const child = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: join(import.meta.dir, '../../../..'),
      env: { ...process.env, HOME: home, KORTIX_CONFIG_FILE: custom,
        KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', HOST_STORAGE_SCENARIO: scenario },
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    if (scenario === 'override-isolation') {
      expect(result.token).toBe('');
      expect(result.tuiToken).toBeUndefined();
      expect(result.legacyExists).toBe(true);
      expect(result.mode).toBeNull();
    } else {
      expect(result.token).toBe('synthetic-migration-token');
      expect(result.tuiToken).toBe('synthetic-migration-token');
      expect(result.legacyExists).toBe(scenario !== 'default-migration');
      if (process.platform !== 'win32') expect(result.mode).toBe(0o600);
    }
  });
}
