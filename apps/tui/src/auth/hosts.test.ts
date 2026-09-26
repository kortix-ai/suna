import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '@kortix/cli/src/api/config.ts';

import { hostToResolved, resolveHost, resolvedFromHost, tokenRejectionNotice } from './hosts.ts';

/**
 * `@kortix/cli`'s config module reads `KORTIX_CONFIG_FILE` on every call and
 * gives a custom path a fresh empty config, so these tests never touch the
 * developer's real `~/.config/kortix/config.json`.
 */
const scratchDirs: string[] = [];

function writeConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-tui-hosts-'));
  scratchDirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  process.env.KORTIX_CONFIG_FILE = path;
  return path;
}

afterEach(() => {
  delete process.env.KORTIX_CONFIG_FILE;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = {
  active: 'local-dev',
  hosts: {
    'local-dev': {
      url: 'http://localhost:17408',
      token: 'config-token',
      user_id: 'u1',
      user_email: 'dev@kortix.test',
      account_id: 'acct-config',
      default_project: { project_id: 'proj-config', account_id: 'acct-config' },
      logged_in_at: '2026-09-17T00:00:00.000Z',
    },
  },
};

describe('resolveHost', () => {
  test('returns null when nothing is configured', () => {
    writeConfig({ active: 'cloud', hosts: {} });
    expect(resolveHost({})).toBeNull();
  });

  test('returns null when the active host has no token', () => {
    writeConfig({
      active: 'cloud',
      hosts: {
        cloud: {
          url: 'https://api.kortix.com',
          token: '',
          user_id: '',
          user_email: '',
          account_id: '',
          logged_in_at: '2026-09-17T00:00:00.000Z',
        },
      },
    });
    expect(resolveHost({})).toBeNull();
  });

  test('reads the active host from the CLI config', () => {
    writeConfig(CONFIG);
    const host = resolveHost({});
    expect(host).not.toBeNull();
    expect(host?.name).toBe('local-dev');
    expect(host?.source).toBe('config');
    expect(host?.token).toBe('config-token');
    expect(host?.backendUrl).toBe('http://localhost:17408/v1');
    expect(host?.accountId).toBe('acct-config');
    expect(host?.defaultProjectId).toBe('proj-config');
    expect(host?.userEmail).toBe('dev@kortix.test');
  });

  test('KORTIX_API_KEY + KORTIX_API_URL beat the config', () => {
    writeConfig(CONFIG);
    const host = resolveHost({
      KORTIX_API_URL: 'http://localhost:9999',
      KORTIX_API_KEY: 'env-token',
    });
    expect(host?.source).toBe('env');
    expect(host?.name).toBe('env');
    expect(host?.token).toBe('env-token');
    expect(host?.backendUrl).toBe('http://localhost:9999/v1');
  });

  test('KORTIX_TOKEN is honored too (CLI parity)', () => {
    writeConfig({ active: 'cloud', hosts: {} });
    const host = resolveHost({ KORTIX_API_URL: 'http://localhost:9999', KORTIX_TOKEN: 'sandbox' });
    expect(host?.token).toBe('sandbox');
    expect(host?.source).toBe('env');
  });

  test('an env token with no env URL falls back to the cloud base', () => {
    writeConfig({ active: 'cloud', hosts: {} });
    expect(resolveHost({ KORTIX_API_KEY: 'env-token' })?.backendUrl).toBe(
      'https://api.kortix.com/v1',
    );
  });

  test('a backend URL that already carries /v1 is not doubled', () => {
    writeConfig({ active: 'cloud', hosts: {} });
    expect(
      resolveHost({ KORTIX_API_KEY: 't', KORTIX_API_URL: 'http://localhost:17408/v1' })?.backendUrl,
    ).toBe('http://localhost:17408/v1');
  });

  test('an env URL alone cannot create a host', () => {
    writeConfig({ active: 'cloud', hosts: {} });
    expect(resolveHost({ KORTIX_API_URL: 'http://localhost:9999' })).toBeNull();
  });
});

describe('resolveHost — KORTIX_TUI_HOST', () => {
  const TWO_HOSTS = {
    active: 'local-dev',
    hosts: {
      ...CONFIG.hosts,
      cloud: {
        url: 'https://api.kortix.com',
        token: 'cloud-token',
        user_id: 'u2',
        user_email: 'ada@kortix.com',
        account_id: 'acct-cloud',
        logged_in_at: '2026-09-17T00:00:00.000Z',
      },
    },
  };

  test('a named host beats the active one — that is what `kortix tui --host` sends', () => {
    writeConfig(TWO_HOSTS);
    const host = resolveHost({ KORTIX_TUI_HOST: 'cloud' });
    expect(host).toMatchObject({
      name: 'cloud',
      backendUrl: 'https://api.kortix.com/v1',
      token: 'cloud-token',
      source: 'config',
    });
  });

  test('it also beats a stale KORTIX_TOKEN exported in the shell', () => {
    // Without this, `kortix tui --host cloud` would silently open the sandbox
    // host instead and the flag would do nothing.
    writeConfig(TWO_HOSTS);
    expect(
      resolveHost({ KORTIX_TUI_HOST: 'cloud', KORTIX_TOKEN: 'kortix_sb_stale' }),
    ).toMatchObject({ name: 'cloud', token: 'cloud-token', source: 'config' });
  });

  test('an unknown or token-less name falls through to the normal order', () => {
    writeConfig(TWO_HOSTS);
    expect(resolveHost({ KORTIX_TUI_HOST: 'ghost' })).toMatchObject({ name: 'local-dev' });
    expect(resolveHost({ KORTIX_TUI_HOST: '   ' })).toMatchObject({ name: 'local-dev' });
  });
});

describe('hostToResolved', () => {
  const TOKEN = 'kortix_pat_super_secret_value_0123456789';
  const host: Host = {
    url: 'http://localhost:17408',
    token: TOKEN,
    user_id: 'user-1',
    user_email: 'agent-g@kortix.test',
    account_id: 'acc-1',
    default_project: { project_id: 'p1', account_id: 'acc-1' },
    logged_in_at: '2026-09-17T12:00:00.000Z',
  };

  test('resolves a stored host with a token', () => {
    const resolved = hostToResolved({ name: 'local-dev' }, { read: () => host });
    expect(resolved).toEqual({
      name: 'local-dev',
      backendUrl: 'http://localhost:17408/v1',
      token: TOKEN,
      accountId: 'acc-1',
      defaultProjectId: 'p1',
      userEmail: 'agent-g@kortix.test',
      source: 'config',
    });
  });

  test('a host with no token does not resolve', () => {
    expect(hostToResolved({ name: 'cloud' }, { read: () => ({ ...host, token: '' }) })).toBeNull();
    expect(hostToResolved({ name: 'gone' }, { read: () => null })).toBeNull();
  });

  test('resolvedFromHost adds the /v1 mount the SDK requires', () => {
    expect(resolvedFromHost('x', { ...host, url: 'http://localhost:17408/v1' }).backendUrl).toBe(
      'http://localhost:17408/v1',
    );
  });
});

describe('env token provenance', () => {
  test('KORTIX_TOKEN resolves to the synthetic sandbox host, like the CLI', () => {
    writeConfig(CONFIG);
    const host = resolveHost({ KORTIX_TOKEN: 'kortix_sb_stale' });
    expect(host?.source).toBe('env');
    expect(host?.name).toBe('sandbox');
    expect(host?.envVar).toBe('KORTIX_TOKEN');
    // A stale sandbox token still outranks the config host (CLI parity).
    expect(host?.token).toBe('kortix_sb_stale');
  });

  test('KORTIX_API_KEY wins over KORTIX_TOKEN and is named env', () => {
    writeConfig(CONFIG);
    const host = resolveHost({ KORTIX_TOKEN: 'kortix_sb_stale', KORTIX_API_KEY: 'kortix_pat_x' });
    expect(host?.name).toBe('env');
    expect(host?.envVar).toBe('KORTIX_API_KEY');
    expect(host?.token).toBe('kortix_pat_x');
  });

  test('a config host carries no envVar', () => {
    writeConfig(CONFIG);
    expect(resolveHost({})?.envVar).toBeUndefined();
  });
});

describe('tokenRejectionNotice', () => {
  const base = { backendUrl: 'https://api.kortix.com/v1' };
  test('names the shell variable when the token came from the environment', () => {
    const line = tokenRejectionNotice(
      { ...base, name: 'sandbox', source: 'env', envVar: 'KORTIX_TOKEN' },
      401,
      'Invalid or expired token',
    );
    expect(line).toContain('401: Invalid or expired token');
    expect(line).toContain('KORTIX_TOKEN is set in this shell');
    expect(line).toContain('host sandbox');
    expect(line).not.toContain('kortix_sb_');
  });
  test('points a config host at kortix login', () => {
    const line = tokenRejectionNotice(
      { ...base, name: 'cloud', source: 'config' },
      401,
      'PAT revoked',
    );
    expect(line).toContain('Run kortix login');
    expect(line).not.toContain('is set in this shell');
  });
  test('a transport failure has no status prefix', () => {
    expect(
      tokenRejectionNotice({ ...base, name: 'cloud', source: 'config' }, 0, 'fetch failed'),
    ).toContain('— fetch failed.');
  });
});
