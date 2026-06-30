import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRoles } from '../commands/roles.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string; body: any }> = [];

// Built-in `viewer` (read-only) + a custom `support_agent` role.
const ROLES = [
  { role_id: 'builtin:user', key: 'user', name: 'User', description: null, resource_type: 'project', is_system: true, account_id: null },
  { role_id: 'role_77', key: 'support_agent', name: 'Support Agent', description: 'Read + run', resource_type: 'project', is_system: false, account_id: 'account_1' },
];

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

function mockApi() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: any = undefined;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    requests.push({ url, method, body });

    const has = (p: string) => url.includes(p);
    if (has('/iam/roles/role_77/permissions')) return json({ role_id: 'role_77', key: 'support_agent', actions: ['project.read', 'project.session.start'] });
    if (has('/iam/roles/role_77/usage')) return json({ role_id: 'role_77', policy_count: 1 });
    if (has('/iam/roles/role_77') && method === 'DELETE') return json({ deleted: true });
    if (has('/iam/roles') && method === 'POST') return json({ role_id: 'role_new', key: body?.key, name: body?.name, resource_type: body?.resourceType, is_system: false, account_id: 'account_1' });
    if (has('/iam/roles')) return json({ roles: ROLES });
    if (has('/iam/actions')) return json({ actions: [{ action: 'project.read', label: 'Read project', resource_type: 'project' }] });
    if (has('/iam/policies:bulk-import') && method === 'POST') {
      const n = (body?.policies ?? []).length;
      return json({ attempted: n, created: n, skipped: 0, errors: [] });
    }
    if (has('/iam/policies') && method === 'POST') return json({ policy_id: 'pol_1', principal_type: body?.principalType, principal_id: body?.principalId, scope_type: body?.scopeType, scope_id: body?.scopeId, role_id: body?.roleId, effect: 'allow', created_at: '2026-01-01T00:00:00.000Z' });
    if (has('/iam/policies')) return json({ policies: [{ policy_id: 'pol_1', principal_type: 'member', principal_id: 'user-9', scope_type: 'project', scope_id: 'proj-1', role_id: 'role_77', effect: 'allow', created_at: '2026-01-01T00:00:00.000Z' }] });
    return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-roles-test-'));
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

describe('kortix roles', () => {
  test('ls lists built-in + custom roles, scoped to the active account', async () => {
    const code = await runRoles(['ls']);
    expect(code).toBe(0);
    expect(requests[0].url).toContain('/v1/accounts/account_1/iam/roles');
    const out = stripAnsi(stdout);
    expect(out).toContain('support_agent');
    expect(out).toContain('built-in');
    expect(out).toContain('custom');
  });

  test('ls --json emits the raw roles array', async () => {
    const code = await runRoles(['ls', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Array<{ key: string }>;
    expect(parsed.map((r) => r.key)).toContain('support_agent');
  });

  test('create sends key/name/resourceType/actions to POST /iam/roles', async () => {
    const code = await runRoles([
      'create', 'support_agent',
      '--name', 'Support Agent',
      '--scope', 'project',
      '--actions', 'project.read, project.session.start',
    ]);
    expect(code).toBe(0);
    const post = requests.find((r) => r.method === 'POST' && r.url.includes('/iam/roles'));
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({
      key: 'support_agent',
      name: 'Support Agent',
      resourceType: 'project',
      actions: ['project.read', 'project.session.start'], // trimmed
    });
  });

  test('create rejects an invalid key client-side (no round-trip) and suggests a fix', async () => {
    const code = await runRoles(['create', 'support-agent', '--name', 'X', '--actions', 'project.read']);
    expect(code).toBe(2);
    const err = stripAnsi(stderr);
    expect(err).toContain('[a-z0-9_]');
    expect(err).toContain('support_agent'); // hyphen → underscore suggestion
    // Never hit the API.
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  test('assign binds a role to a principal at project scope (POST /iam/policies)', async () => {
    const code = await runRoles(['assign', 'support_agent', '--to', 'member:user-9', '--project', 'proj-1']);
    expect(code).toBe(0);
    const post = requests.find((r) => r.method === 'POST' && r.url.includes('/iam/policies'));
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({
      principalType: 'member',
      principalId: 'user-9',
      scopeType: 'project',
      scopeId: 'proj-1',
      roleId: 'role_77', // resolved from the key
    });
  });

  test('assignments filters policies by project scope', async () => {
    const code = await runRoles(['assignments', '--project', 'proj-1']);
    expect(code).toBe(0);
    const get = requests.find((r) => r.method === 'GET' && r.url.includes('/iam/policies'));
    expect(get!.url).toContain('scopeType=project');
    expect(get!.url).toContain('scopeId=proj-1');
  });

  test('set-actions refuses a built-in role', async () => {
    const code = await runRoles(['set-actions', 'user', '--actions', 'project.read']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('read-only');
    // No PUT was attempted.
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  test('rm refuses a built-in role but deletes a custom one', async () => {
    expect(await runRoles(['rm', 'user'])).toBe(2);
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);

    requests = [];
    const code = await runRoles(['rm', 'support_agent']);
    expect(code).toBe(0);
    expect(requests.some((r) => r.method === 'DELETE' && r.url.includes('/iam/roles/role_77'))).toBe(true);
  });

  test('export emits only custom roles (with actions) + bindings as TOML', async () => {
    const code = await runRoles(['export']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('[[roles]]');
    expect(out).toContain('key = "support_agent"'); // custom role
    expect(out).not.toContain('key = "user"'); // built-in excluded
    expect(out).toContain('[[policies]]');
    expect(out).toContain('role_key = "support_agent"'); // bound by KEY (portable)
  });

  test('import creates missing roles and dedupes already-existing bindings', async () => {
    // Existing live state (from the mock): role support_agent=role_77, and one
    // policy member:user-9 @ project:proj-1 → role_77.
    const file = join(tmp, 'pol.toml');
    writeFileSync(
      file,
      [
        '[[roles]]', 'key = "support_agent"', 'name = "Support Agent"', 'resource_type = "project"', 'actions = ["project.read"]', '',
        '[[roles]]', 'key = "new_role"', 'name = "New Role"', 'resource_type = "project"', 'actions = ["project.read"]', '',
        '[[policies]]', 'role_key = "support_agent"', 'principal_type = "member"', 'principal_id = "user-9"', 'scope_type = "project"', 'scope_id = "proj-1"', '',
        '[[policies]]', 'role_key = "support_agent"', 'principal_type = "member"', 'principal_id = "user-NEW"', 'scope_type = "project"', 'scope_id = "proj-1"', '',
      ].join('\n'),
      'utf8',
    );
    const code = await runRoles(['import', file]);
    expect(code).toBe(0);
    // Only the NEW role is created (support_agent already exists).
    const rolePosts = requests.filter((r) => r.method === 'POST' && /\/iam\/roles(\?|$)/.test(r.url));
    expect(rolePosts.length).toBe(1);
    expect(rolePosts[0].body.key).toBe('new_role');
    // Bulk-import receives ONLY the new binding; user-9 matches the live policy.
    const bulk = requests.find((r) => r.method === 'POST' && r.url.includes(':bulk-import'));
    expect(bulk).toBeDefined();
    expect(bulk!.body.policies.length).toBe(1);
    expect(bulk!.body.policies[0].principal_id).toBe('user-NEW');
  });
});
