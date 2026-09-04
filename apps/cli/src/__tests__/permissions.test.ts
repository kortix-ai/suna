import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPermissions } from '../commands/permissions.ts';
import { runRoles } from '../commands/roles.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

const PERMISSIONS = [
  {
    action: 'project.secret.write',
    scope_type: 'project',
    resource_type: 'project',
    delegable: true,
    description: 'Create, edit and delete project secrets',
    area: 'secrets',
    level: 'edit',
    implies: ['project.secret.read'],
  },
  {
    action: 'account.delete',
    scope_type: 'account',
    resource_type: 'account',
    delegable: false,
    description: 'Delete the account',
    area: 'account',
    level: 'admin',
    implies: [],
  },
];

const ROLES = [
  { role_id: 'builtin:manager', key: 'manager', name: 'Manager', description: null, resource_type: 'project', is_system: true, account_id: null },
  { role_id: 'role_77', key: 'support_agent', name: 'Support Agent', description: null, resource_type: 'project', is_system: false, account_id: 'account_1' },
];

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string }> = [];

function writeConfig(): void {
  const file = join(tmp, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: 'https://api.test',
          token: 'tok_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = file;
}

function captureOutput() {
  stdout = '';
  stderr = '';
  (process.stdout as any).write = (chunk: unknown) => ((stdout += String(chunk)), true);
  (process.stderr as any).write = (chunk: unknown) => ((stderr += String(chunk)), true);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    if (url.includes('/iam/permissions')) {
      const scope = new URL(url).searchParams.get('scope_type');
      return json({
        permissions: scope ? PERMISSIONS.filter((p) => p.scope_type === scope) : PERMISSIONS,
      });
    }
    // The role id is url-encoded — `builtin:manager` arrives as `builtin%3Amanager`.
    if (/\/iam\/roles\/[^/]+\/permissions/.test(url)) {
      return json({ role_id: 'builtin:manager', key: 'manager', actions: ['project.write', 'project.read'] });
    }
    if (url.includes('/iam/roles')) return json({ roles: ROLES });
    return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-perms-test-'));
  process.chdir(tmp);
  writeConfig();
  captureOutput();
  requests = [];
  mockApi();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
  (process.stderr as any).write = ORIGINAL_STDERR_WRITE;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix permissions', () => {
  test('ls reads the catalog and prints area / level / delegable', async () => {
    const code = await runPermissions(['ls']);
    expect(code).toBe(0);
    expect(requests[0].url).toContain('/v1/accounts/account_1/iam/permissions');
    const out = stripAnsi(stdout);
    expect(out).toContain('ACTION');
    expect(out).toContain('AREA');
    expect(out).toContain('LEVEL');
    expect(out).toContain('DELEGABLE');
    expect(out).toContain('project.secret.write');
    expect(out).toContain('secrets');
    expect(out).toContain('edit');
    // The escalation ceiling is legible on the row itself.
    expect(out).toContain('account.delete');
    expect(out).toContain('no');
    expect(out).toContain('2 permissions');
  });

  test('--scope is sent to the server, not filtered client-side', async () => {
    const code = await runPermissions(['ls', '--scope', 'project']);
    expect(code).toBe(0);
    expect(requests[0].url).toContain('scope_type=project');
    const out = stripAnsi(stdout);
    expect(out).toContain('project.secret.write');
    expect(out).not.toContain('account.delete');
  });

  test('--scope rejects an unknown value without a round-trip', async () => {
    const code = await runPermissions(['ls', '--scope', 'sandbox']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('--scope must be one of account, project');
    expect(requests).toHaveLength(0);
  });

  test('--area narrows to one area', async () => {
    const code = await runPermissions(['ls', '--area', 'secrets']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('project.secret.write');
    expect(out).not.toContain('account.delete');
    expect(out).toContain('1 permission');
  });

  test('--json emits the raw catalog', async () => {
    const code = await runPermissions(['ls', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { permissions: Array<{ action: string }> };
    expect(parsed.permissions.map((p) => p.action)).toContain('account.delete');
  });

  test('show renders one action with its implications', async () => {
    const code = await runPermissions(['show', 'project.secret.write']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('project.secret.write');
    expect(out).toContain('Create, edit and delete project secrets');
    expect(out).toContain('delegable  yes');
    expect(out).toContain('IMPLIES (1)');
    expect(out).toContain('project.secret.read');
  });

  test('show says a non-delegable action can never be handed on', async () => {
    const code = await runPermissions(['show', 'account.delete']);
    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('can never be handed on');
  });

  test('show reports an action that is not in the catalog', async () => {
    const code = await runPermissions(['show', 'project.nope']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('No permission "project.nope"');
  });
});

describe('kortix roles permissions', () => {
  test('lists a role’s leaf actions, sorted, with no usage round-trip', async () => {
    const code = await runRoles(['permissions', 'manager']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('manager');
    expect(out).toContain('project.read');
    expect(out).toContain('project.write');
    expect(out.indexOf('project.read')).toBeLessThan(out.indexOf('project.write'));
    expect(out).toContain('2 permissions');
    expect(requests.some((r) => r.url.includes('/usage'))).toBe(false);
  });

  test('--json carries is_system alongside the actions', async () => {
    const code = await runRoles(['permissions', 'manager', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { key: string; is_system: boolean; actions: string[] };
    expect(parsed.key).toBe('manager');
    expect(parsed.is_system).toBe(true);
    expect(parsed.actions).toEqual(['project.read', 'project.write']);
  });

  test('reports an unknown role', async () => {
    const code = await runRoles(['permissions', 'editor']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('No role "editor"');
  });
});
