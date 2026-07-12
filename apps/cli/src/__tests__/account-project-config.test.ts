import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activeAccount,
  clearDefaultProject,
  defaultProject,
  loadConfig,
  setActiveAccount,
  setDefaultProject,
} from '../api/config.ts';
import { resolveProjectId, saveLink } from '../project-link.ts';
import { renderContext, renderHostNotice } from '../host-notice.ts';
import { stripAnsi } from '../style.ts';

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'BASH_ENV',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;

function writeConfig(hosts: Record<string, unknown>, active = 'test'): void {
  const file = join(tmp, 'config.json');
  writeFileSync(file, JSON.stringify({ active, hosts }, null, 2));
  process.env.KORTIX_CONFIG_FILE = file;
}

function loggedInHost(extra: Record<string, unknown> = {}) {
  return {
    url: 'https://api.test',
    token: 'tok_test',
    user_id: 'user_1',
    user_email: 'user@example.test',
    account_id: 'account_1',
    logged_in_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-acct-cfg-'));
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('config: account + default-project state', () => {
  test('old config without the new fields still loads (back-compat)', () => {
    writeConfig({ test: loggedInHost() });
    const config = loadConfig();
    expect(config.active).toBe('test');
    expect(config.hosts.test.account_id).toBe('account_1');
    expect(config.hosts.test.default_project).toBeUndefined();
    expect(activeAccount()).toEqual({ id: 'account_1', slug: 'account_', name: '' });
  });

  test('setActiveAccount persists display fields and round-trips', () => {
    writeConfig({ test: loggedInHost({ account_id: '' }) });
    setActiveAccount({ id: 'acc_kortix', slug: 'kortix', name: 'Kortix' });
    expect(activeAccount()).toEqual({ id: 'acc_kortix', slug: 'kortix', name: 'Kortix' });
    // Persisted to disk, not just in memory.
    const onDisk = JSON.parse(readFileSync(process.env.KORTIX_CONFIG_FILE!, 'utf8'));
    expect(onDisk.hosts.test.account_slug).toBe('kortix');
    expect(onDisk.hosts.test.account_name).toBe('Kortix');
  });

  test('setDefaultProject + defaultProject round-trip and clearDefaultProject removes it', () => {
    writeConfig({ test: loggedInHost() });
    setDefaultProject({ project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' });
    expect(defaultProject()).toEqual({ project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' });
    expect(clearDefaultProject()).toBe(true);
    expect(defaultProject()).toBeNull();
    expect(clearDefaultProject()).toBe(false);
  });

  test('switching to a different account drops a now-foreign default project', () => {
    writeConfig({
      test: loggedInHost({
        default_project: { project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' },
      }),
    });
    expect(defaultProject()?.project_id).toBe('proj_a');
    setActiveAccount({ id: 'account_2', slug: 'two', name: 'Two' });
    expect(defaultProject()).toBeNull();
  });

  test('switching to the SAME account keeps the default project', () => {
    writeConfig({
      test: loggedInHost({
        default_project: { project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' },
      }),
    });
    setActiveAccount({ id: 'account_1', slug: 'one', name: 'One' });
    expect(defaultProject()?.project_id).toBe('proj_a');
  });
});

describe('resolveProjectId fallback order', () => {
  test('falls back to the active host default project when no link / env', () => {
    writeConfig({
      test: loggedInHost({
        default_project: { project_id: 'proj_default', account_id: 'account_1' },
      }),
    });
    process.chdir(tmp); // linkless dir
    expect(resolveProjectId()).toBe('proj_default');
  });

  test('explicit arg and KORTIX_PROJECT_ID outrank the default', () => {
    writeConfig({
      test: loggedInHost({
        default_project: { project_id: 'proj_default', account_id: 'account_1' },
      }),
    });
    process.chdir(tmp);
    expect(resolveProjectId('explicit')).toBe('explicit');
    process.env.KORTIX_PROJECT_ID = 'env_proj';
    expect(resolveProjectId()).toBe('env_proj');
  });

  test('a directory link outranks the default project', () => {
    writeConfig({
      test: loggedInHost({
        default_project: { project_id: 'proj_default', account_id: 'account_1' },
      }),
    });
    mkdirSync(join(tmp, '.kortix'), { recursive: true });
    process.chdir(tmp);
    saveLink(
      { project_id: 'proj_linked', account_id: 'account_1', linked_at: '2026-01-01T00:00:00.000Z' },
      tmp,
    );
    expect(existsSync(join(tmp, '.kortix', 'link.json'))).toBe(true);
    expect(resolveProjectId()).toBe('proj_linked');
  });
});

describe('renderContext + host notice', () => {
  test('context block shows host, account, and default project', () => {
    writeConfig({
      test: loggedInHost({
        account_slug: 'kortix',
        account_name: 'Kortix',
        default_project: { project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' },
      }),
    });
    process.chdir(tmp);
    const out = stripAnsi(renderContext());
    expect(out).toContain('host');
    expect(out).toContain('test');
    expect(out).toContain('account');
    expect(out).toContain('Kortix');
    expect(out).toContain('project');
    expect(out).toContain('Alpha');
    expect(out).toContain('(default)');
    // A bound default project points at the switch verb.
    expect(out).toContain('switch with `kortix projects use`');
  });

  test('a directory-linked project does not show the default-project switch hint', () => {
    writeConfig({
      test: loggedInHost({
        account_slug: 'kortix',
        account_name: 'Kortix',
        default_project: { project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' },
      }),
    });
    mkdirSync(join(tmp, '.kortix'), { recursive: true });
    saveLink(
      { project_id: 'proj_linked', account_id: 'account_1', linked_at: '2026-01-01T00:00:00.000Z' },
      tmp,
    );
    process.chdir(tmp);
    const out = stripAnsi(renderContext());
    expect(out).toContain('(linked)');
    expect(out).not.toContain('switch with');
  });

  test('context block nudges when account / default project are unset', () => {
    writeConfig({ test: loggedInHost({ account_id: '' }) });
    process.chdir(tmp);
    const out = stripAnsi(renderContext());
    expect(out).toContain('kortix accounts use');
    expect(out).toContain('kortix projects use');
  });

  test('subcommand host notice appends account + default project', () => {
    writeConfig({
      test: loggedInHost({
        account_slug: 'kortix',
        account_name: 'Kortix',
        default_project: { project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' },
      }),
    });
    process.chdir(tmp);
    const notice = stripAnsi(renderHostNotice(['whoami']) ?? '');
    expect(notice).toContain('host test');
    expect(notice).toContain('account Kortix');
    expect(notice).toContain('project Alpha');
    expect(notice).toContain('(default)');
  });

  test('--host override does not claim the active account / project', () => {
    writeConfig({
      test: loggedInHost({
        account_slug: 'kortix',
        account_name: 'Kortix',
        default_project: { project_id: 'proj_a', account_id: 'account_1', name: 'Alpha' },
      }),
    });
    process.chdir(tmp);
    const notice = stripAnsi(renderHostNotice(['whoami', '--host', 'cloud']) ?? '');
    expect(notice).toContain('host cloud');
    expect(notice).not.toContain('account Kortix');
    expect(notice).not.toContain('project Alpha');
  });
});
