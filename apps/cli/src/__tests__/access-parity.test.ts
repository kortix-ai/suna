import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_access';
const INVITE = 'inv_7';
const REQUEST = 'req_3';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
let emailSent = true;

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_access',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

function accessRequest() {
  return {
    request_id: REQUEST,
    account_id: 'account_1',
    project_id: PROJECT,
    requester_user_id: 'user_9',
    requester_email: 'newbie@corp.com',
    message: 'I need this for the launch',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const base = `/v1/projects/${PROJECT}`;

      if (url.pathname === `/v1/projects/${PROJECT}` && req.method === 'GET') {
        return Response.json({ project_id: PROJECT, account_id: 'account_1', name: 'Access' });
      }
      if (url.pathname === `${base}/access/pending-invites/${INVITE}/resend` && req.method === 'POST') {
        return Response.json({
          ok: true,
          expires_at: '2026-01-15T00:00:00.000Z',
          invite_url: 'https://example.test/invite/inv_7',
          email_sent: emailSent,
          email_skip_reason: emailSent ? null : 'no_email_provider',
        });
      }
      if (url.pathname === `${base}/access/pending-invites/inv_missing/resend`) {
        return Response.json({ error: 'Invitation not found' }, { status: 404 });
      }
      if (url.pathname === `${base}/access-requests` && req.method === 'GET') {
        return Response.json({ requests: [accessRequest()] });
      }
      if (url.pathname === `${base}/access-requests/${REQUEST}/approve` && req.method === 'POST') {
        const role = (body as { role?: string })?.role ?? 'member';
        return Response.json({
          request: { ...accessRequest(), status: 'approved' },
          member: {
            user_id: 'user_9',
            email: 'newbie@corp.com',
            account_role: 'member',
            project_role: role,
            effective_project_role: role,
            has_implicit_access: false,
          },
        });
      }
      if (url.pathname === `${base}/access-requests/${REQUEST}/reject` && req.method === 'POST') {
        return Response.json({ request: { ...accessRequest(), status: 'rejected' } });
      }
      if (url.pathname === `${base}/access-requests/req_gone/reject` && req.method === 'POST') {
        return Response.json({ error: 'Access request has already been reviewed' }, { status: 409 });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix access — invites + access requests', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-access-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    emailSent = true;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents resend and the requests block', async () => {
    const r = await runCli(['access', '--help']);
    expect(r.code).toBe(0);
    for (const fragment of ['resend <invite-id>', 'requests ls', 'requests approve <req-id>', 'requests reject <req-id>', 'project.members.manage']) {
      expect(r.stdout).toContain(fragment);
    }
  });

  test('resend POSTs the resend route and prints the link', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'resend', INVITE, '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/access/pending-invites/${INVITE}/resend`,
      body: {},
    });
    expect(r.stdout).toContain('Re-sent invite');
    expect(r.stdout).toContain('https://example.test/invite/inv_7');
  });

  test('resend warns instead of ticking when no email was sent', async () => {
    const config = writeConfig(startServer());
    emailSent = false;
    const r = await runCli(['access', 'resend', INVITE, '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('NO email was sent');
    expect(r.stdout).toContain('no_email_provider');
    expect(r.stdout).toContain('https://example.test/invite/inv_7');
  });

  test('resend --json emits the API body', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'resend', INVITE, '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).invite_url).toBe('https://example.test/invite/inv_7');
  });

  test('resend without an invite id exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'resend', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass an invite id');
  });

  test('requests ls reads the pending list', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'requests', 'ls', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v1/projects/${PROJECT}/access-requests`);
    expect(r.stdout).toContain('newbie@corp.com');
    expect(r.stdout).toContain(REQUEST);
    expect(r.stdout).toContain('I need this for the launch');
  });

  test('bare `requests` defaults to ls', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'requests', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).requests[0].request_id).toBe(REQUEST);
  });

  test('requests approve omits role by default and sends it when asked', async () => {
    const config = writeConfig(startServer());
    const plain = await runCli(['access', 'requests', 'approve', REQUEST, '--project', PROJECT], config);
    expect(plain.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/access-requests/${REQUEST}/approve`,
      body: {},
    });
    expect(plain.stdout).toContain('newbie@corp.com → member');

    calls = [];
    const asManager = await runCli(['access', 'requests', 'approve', REQUEST, '--role', 'manager', '--project', PROJECT], config);
    expect(asManager.code).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ role: 'manager' });
    expect(asManager.stdout).toContain('→ manager');
  });

  test('requests approve rejects a role the API removed', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'requests', 'approve', REQUEST, '--role', 'editor', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--role must be one of manager, member');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('requests reject POSTs the reject route', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'requests', 'reject', REQUEST, '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/access-requests/${REQUEST}/reject`,
      body: {},
    });
    expect(r.stdout).toContain(`Rejected request ${REQUEST}`);
  });

  test('a 409 on an already-reviewed request surfaces the API message', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'requests', 'reject', 'req_gone', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('already been reviewed');
  });

  test('requests approve without an id exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'requests', 'approve', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a request id');
  });

  test('an unknown requests action exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['access', 'requests', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown requests action "nope"');
  });
});
