import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAccess } from '../commands/access.ts';
import { stripAnsi } from '../style.ts';

// `kortix access` over the ONE grant table.
//
// Two shapes share the `grant` / `revoke` verbs: the canonical assignment form
// (--user / --group, or an assignment id) and the historical project-member
// form (a positional user id). Both are pinned here — the split is the reason
// an existing script keeps working while the assignment verbs become the
// documented path.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT = '44444444-4444-4444-4444-444444444444';

const ROLES = [
  { role_id: 'builtin:manager', key: 'manager', name: 'Manager', description: null, resource_type: 'project', is_system: true, account_id: null },
  { role_id: 'builtin:admin', key: 'admin', name: 'Admin', description: null, resource_type: 'account', is_system: true, account_id: null },
  { role_id: 'builtin:agent-user', key: 'agent-user', name: 'Object grant', description: null, resource_type: 'project', is_system: true, account_id: null },
  { role_id: 'role_77', key: 'support_agent', name: 'Support Agent', description: null, resource_type: 'project', is_system: false, account_id: 'account_1' },
];

const ASSIGNMENTS = [
  {
    assignment_id: ASSIGNMENT,
    account_id: 'account_1',
    principal_type: 'user',
    principal_id: USER,
    role_id: 'sys_manager',
    role_key: 'manager',
    role_is_system: true,
    scope_type: 'project',
    scope_id: PROJECT,
    object_type: null,
    object_id: null,
    expires_at: null,
    granted_by: 'user_1',
    source: 'manual',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    assignment_id: '55555555-5555-5555-5555-555555555555',
    account_id: 'account_1',
    principal_type: 'group',
    principal_id: GROUP,
    role_id: 'sys_agent_user',
    role_key: 'agent-user',
    role_is_system: true,
    scope_type: 'project',
    scope_id: PROJECT,
    object_type: 'agent',
    object_id: 'support-bot',
    expires_at: '2026-09-01T00:00:00.000Z',
    granted_by: 'user_1',
    source: 'scim',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string; body: any }> = [];

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
    let body: any = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method, body });

    const has = (p: string) => url.includes(p);
    if (has('/iam/assignments/') && method === 'DELETE') {
      return json({ revoked: true, assignment: ASSIGNMENTS[0] });
    }
    if (has('/iam/assignments') && method === 'POST') {
      return json({
        ...ASSIGNMENTS[0],
        assignment_id: 'new_assignment',
        principal_type: body?.principal_type,
        principal_id: body?.principal_id,
        role_key: body?.role_key ?? 'support_agent',
        scope_type: body?.scope_type,
        scope_id: body?.scope_id ?? null,
        object_type: body?.object_type ?? null,
        object_id: body?.object_id ?? null,
      });
    }
    if (has('/iam/assignments')) return json({ assignments: ASSIGNMENTS });
    if (has('/iam/roles')) return json({ roles: ROLES });
    if (has('/iam/groups')) return json({ groups: [{ group_id: GROUP, name: 'Engineering' }] });
    if (has('/members')) return json([{ user_id: USER, email: 'alice@corp.com' }]);
    if (has('/access/') && method === 'DELETE') return json({ ok: true });
    if (has('/access/') && method === 'PUT') return json({ ok: true });
    if (has(`/projects/${PROJECT}`)) {
      return json({ project_id: PROJECT, account_id: 'account_1', name: 'demo' });
    }
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
  process.env.KORTIX_PROJECT_ID = PROJECT;
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-access-test-'));
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

const assignmentGet = () =>
  requests.find((r) => r.method === 'GET' && r.url.includes('/iam/assignments'));

describe('kortix access assignments', () => {
  test('defaults to the linked project and renders principal · role · scope · object · expires · source', async () => {
    const code = await runAccess(['assignments']);
    expect(code).toBe(0);
    const get = assignmentGet()!;
    expect(get.url).toContain('/v1/accounts/account_1/iam/assignments');
    expect(get.url).toContain('scope_type=project');
    expect(get.url).toContain(`scope_id=${PROJECT}`);
    const out = stripAnsi(stdout);
    expect(out).toContain('PRINCIPAL');
    expect(out).toContain('OBJECT');
    // Principals are labelled, not raw uuids.
    expect(out).toContain('user:alice@corp.com');
    expect(out).toContain('group:Engineering');
    expect(out).toContain('manager');
    expect(out).toContain('agent:support-bot');
    expect(out).toContain('never'); // no expiry on the first row
    expect(out).toContain('2026-09-01'); // expiry on the second
    expect(out).toContain('scim');
    // The assignment id is printed — it is the handle `revoke` takes.
    expect(out).toContain(ASSIGNMENT);
  });

  test('--account filters to account-scope assignments and never resolves a project', async () => {
    const code = await runAccess(['assignments', '--account']);
    expect(code).toBe(0);
    expect(assignmentGet()!.url).toContain('scope_type=account');
    expect(requests.some((r) => r.url.includes(`/projects/${PROJECT}`))).toBe(false);
  });

  test('--all drops the scope filter entirely', async () => {
    const code = await runAccess(['assignments', '--all']);
    expect(code).toBe(0);
    expect(assignmentGet()!.url).not.toContain('scope_type');
  });

  test('--principal takes a bare user id or an explicit type:id', async () => {
    expect(await runAccess(['assignments', '--all', '--principal', USER])).toBe(0);
    expect(assignmentGet()!.url).toContain('principal_type=user');
    expect(assignmentGet()!.url).toContain(`principal_id=${USER}`);

    requests = [];
    expect(await runAccess(['assignments', '--all', '--principal', `group:${GROUP}`])).toBe(0);
    expect(assignmentGet()!.url).toContain('principal_type=group');
  });

  test('--principal rejects an unknown principal type without a round-trip', async () => {
    const code = await runAccess(['assignments', '--all', '--principal', 'robot:123']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('--principal must be');
    expect(assignmentGet()).toBeUndefined();
  });

  test('--json emits the raw payload', async () => {
    const code = await runAccess(['assignments', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { assignments: Array<{ assignment_id: string }> };
    expect(parsed.assignments).toHaveLength(2);
    expect(parsed.assignments[0].assignment_id).toBe(ASSIGNMENT);
  });
});

describe('kortix access grant (assignment form)', () => {
  const post = () => requests.find((r) => r.method === 'POST' && r.url.includes('/iam/assignments'));

  test('resolves an email to a user id and references a system role BY KEY', async () => {
    const code = await runAccess(['grant', '--user', 'alice@corp.com', '--role', 'manager']);
    expect(code).toBe(0);
    expect(post()!.body).toMatchObject({
      principal_type: 'user',
      principal_id: USER,
      // A system role's `builtin:` id is not resolvable by the assignment
      // route — the key is.
      role_key: 'manager',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(post()!.body.role_id).toBeUndefined();
    const out = stripAnsi(stdout);
    expect(out).toContain('Granted');
    expect(out).toContain('kortix access revoke new_assignment');
  });

  test('references a CUSTOM role by id', async () => {
    const code = await runAccess(['grant', '--group', GROUP, '--role', 'support_agent']);
    expect(code).toBe(0);
    expect(post()!.body).toMatchObject({
      principal_type: 'group',
      principal_id: GROUP,
      role_id: 'role_77',
      scope_type: 'project',
    });
    expect(post()!.body.role_key).toBeUndefined();
  });

  test('--account grants at account scope with a null scope id', async () => {
    const code = await runAccess(['grant', '--user', USER, '--role', 'admin', '--account']);
    expect(code).toBe(0);
    expect(post()!.body).toMatchObject({ scope_type: 'account', scope_id: null, role_key: 'admin' });
  });

  test('--agent narrows the grant to one object and defaults the role to agent-user', async () => {
    const code = await runAccess(['grant', '--user', USER, '--agent', 'support-bot']);
    expect(code).toBe(0);
    expect(post()!.body).toMatchObject({
      role_key: 'agent-user',
      scope_type: 'project',
      scope_id: PROJECT,
      object_type: 'agent',
      object_id: 'support-bot',
    });
  });

  test('--agent with --account is refused client-side: an object grant is project-scoped', async () => {
    const code = await runAccess(['grant', '--user', USER, '--agent', 'support-bot', '--account']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('project-scoped');
    expect(post()).toBeUndefined();
  });

  test('--service-account grants to an agent identity', async () => {
    const code = await runAccess([
      'grant', '--service-account', '66666666-6666-4666-8666-666666666666', '--role', 'manager',
    ]);
    expect(code).toBe(0);
    expect(post()!.body).toMatchObject({
      principal_type: 'service_account',
      principal_id: '66666666-6666-4666-8666-666666666666',
      role_key: 'manager',
    });
  });

  test('two principals at once is refused, and names both', async () => {
    const code = await runAccess(['grant', '--user', USER, '--group', GROUP, '--role', 'manager']);
    expect(code).toBe(2);
    const err = stripAnsi(stderr);
    expect(err).toContain('Pass one principal');
    expect(err).toContain('--user and --group');
  });

  test('a role the catalog route does not list is still sent as a key — the server decides', async () => {
    // `GET /iam/roles` still serves stale presets: it omits `agent-user` and
    // calls the project floor role `user` where the engine calls it `member`.
    // Refusing client-side would block valid grants; the server answers
    // `unknown system role "project:<key>"` when a key really is wrong.
    const code = await runAccess(['grant', '--user', USER, '--role', 'not_in_the_catalog']);
    expect(code).toBe(0);
    expect(post()!.body).toMatchObject({ role_key: 'not_in_the_catalog' });
    expect(post()!.body.role_id).toBeUndefined();
  });

  test('a system role named by its synthetic builtin id is sent by KEY', async () => {
    const code = await runAccess(['grant', '--user', USER, '--role', 'builtin:manager']);
    expect(code).toBe(0);
    expect(post()!.body).toMatchObject({ role_key: 'manager' });
    expect(post()!.body.role_id).toBeUndefined();
  });

  test('--expires is passed through', async () => {
    const code = await runAccess([
      'grant', '--user', USER, '--role', 'manager', '--expires', '2026-12-01T00:00:00.000Z',
    ]);
    expect(code).toBe(0);
    expect(post()!.body.expires_at).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('kortix access — the project-member form is unchanged', () => {
  test('grant <user-id> --role still PUTs the project access route', async () => {
    const code = await runAccess(['grant', USER, '--role', 'manager']);
    expect(code).toBe(0);
    const put = requests.find((r) => r.method === 'PUT');
    expect(put!.url).toContain(`/projects/${PROJECT}/access/${USER}`);
    expect(put!.body).toMatchObject({ role: 'manager' });
    // No assignment was written.
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  test('grant with neither a user id nor --user points at the assignment form', async () => {
    const code = await runAccess(['grant', '--role', 'manager']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('kortix access grant --user');
  });
});

describe('kortix access revoke', () => {
  test('an assignment id DELETEs the assignment and names what was revoked', async () => {
    const code = await runAccess(['revoke', ASSIGNMENT]);
    expect(code).toBe(0);
    const del = requests.find((r) => r.method === 'DELETE')!;
    expect(del.url).toContain(`/iam/assignments/${ASSIGNMENT}`);
    const out = stripAnsi(stdout);
    expect(out).toContain('Revoked manager');
    expect(out).toContain('user:alice@corp.com');
  });

  test('a user id falls through to the project access route, exactly as before', async () => {
    const code = await runAccess(['revoke', USER]);
    expect(code).toBe(0);
    const del = requests.find((r) => r.method === 'DELETE')!;
    expect(del.url).toContain(`/projects/${PROJECT}/access/${USER}`);
    expect(stripAnsi(stdout)).toContain(`Revoked access for ${USER}`);
  });
});

// P7 live check, 2026-08-19. `grant --user <email>` resolves an email through
// the member directory; `assignments --principal user:<email>` sent it straight
// through as `principal_id` and the server answered
// `HTTP 400: principal_id must be a UUID`. One identifier, two verbs, one
// resolution — the email a person just granted to has to be listable.
describe('kortix access assignments --principal', () => {
  test('resolves an email to the user id before filtering', async () => {
    const code = await runAccess(['assignments', '--account', '--principal', 'user:alice@corp.com']);
    expect(code).toBe(0);
    const listed = requests.find((r) => r.method === 'GET' && r.url.includes('/iam/assignments?'));
    expect(listed).toBeDefined();
    expect(listed!.url).toContain(`principal_id=${USER}`);
    expect(listed!.url).toContain('principal_type=user');
    expect(listed!.url).not.toContain('alice%40corp.com');
  });

  test('passes a uuid through without a directory lookup', async () => {
    const code = await runAccess(['assignments', '--account', '--principal', `user:${USER}`]);
    expect(code).toBe(0);
    const listed = requests.find((r) => r.method === 'GET' && r.url.includes('/iam/assignments?'));
    expect(listed!.url).toContain(`principal_id=${USER}`);
    expect(listed!.url).toContain('principal_type=user');
  });
});
