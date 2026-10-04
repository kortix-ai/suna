import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProjectId } from '../project-link.ts';
import { resolveProjectContext as resolveContext } from '../command-helpers.ts';

/**
 * KRTX-1438 — the CLI project flow inside a session.
 *
 * A session sandbox injects KORTIX_TOKEN (a project+session-scoped PAT) and
 * KORTIX_PROJECT_ID (the session's own project). Both describe the SESSION,
 * yet they used to outrank the user's own explicit context: a directory linked
 * to another project, and a PAT logged in via `kortix login --host <name>`,
 * were both ignored — so init → ship → files against the account's own other
 * project died with "linked project no longer exists", 403s and "Not found".
 *
 * Every blackbox case here spawns the REAL command module against a fake API
 * that enforces the session token's project scope (403 on any other project),
 * exactly what the platform's auth middleware does.
 */

const SESSION_TOKEN = 'kortix_pat_session';
const DEV_TOKEN = 'kortix_pat_dev';

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'BASH_ENV',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
  'KORTIX_NO_UPDATE_CHECK',
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-project-flag-'));
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(hosts: Record<string, unknown>, active = 'devhost'): void {
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ active, hosts }, null, 2));
  process.env.KORTIX_CONFIG_FILE = join(tmp, 'config.json');
}

function devHost(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://dev-api.kortix.com',
    token: DEV_TOKEN,
    user_id: 'user_1',
    user_email: 'user@example.test',
    account_id: 'account_1',
    logged_in_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function enterLinkedDir(link: Record<string, unknown>): void {
  mkdirSync(join(tmp, '.kortix'), { recursive: true });
  writeFileSync(join(tmp, '.kortix', 'link.json'), JSON.stringify(link, null, 2));
  process.chdir(tmp);
}

function enterProjectDir(): void {
  mkdirSync(join(tmp, '.kortix'), { recursive: true });
  writeFileSync(join(tmp, 'kortix.yaml'), 'kortix_version: 1\nproject:\n  name: dogfood-run\n');
  process.chdir(tmp);
  const git = Bun.spawnSync(['git', 'init', '-q', tmp]);
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
}

function projectRow(id: string, name = 'Target'): Record<string, unknown> {
  return {
    project_id: id,
    account_id: 'account_1',
    name,
    repo_url: 'https://example.test/t.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    icon: null,
    icon_glyph: null,
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

// ── In-process resolution contracts ─────────────────────────────────────────

describe('project resolution inside a session sandbox', () => {
  it('a .kortix/link.json project outranks KORTIX_PROJECT_ID', () => {
    process.env.KORTIX_TOKEN = SESSION_TOKEN;
    process.env.KORTIX_API_URL = 'https://dev-api.kortix.com/v1';
    process.env.KORTIX_PROJECT_ID = 'proj_session';
    writeConfig({ devhost: devHost() });
    enterLinkedDir({
      project_id: 'proj_linked',
      account_id: 'account_1',
      host: 'devhost',
      linked_at: '2026-01-01T00:00:00.000Z',
    });
    expect(resolveProjectId()).toBe('proj_linked');
  });

  it('a logged-in link host supplies the request principal and the link project', async () => {
    process.env.KORTIX_TOKEN = SESSION_TOKEN;
    process.env.KORTIX_API_URL = 'https://dev-api.kortix.com/v1';
    process.env.KORTIX_PROJECT_ID = 'proj_session';
    writeConfig({ devhost: devHost() });
    enterLinkedDir({
      project_id: 'proj_linked',
      account_id: 'account_1',
      host: 'devhost',
      linked_at: '2026-01-01T00:00:00.000Z',
    });
    const ctx = await resolveContext();
    expect(ctx?.auth.token).toBe(DEV_TOKEN);
    expect(ctx?.projectId).toBe('proj_linked');
  });

  it('a logged-out link host never strands the CLI: env token + link project', async () => {
    process.env.KORTIX_TOKEN = SESSION_TOKEN;
    process.env.KORTIX_API_URL = 'https://dev-api.kortix.com/v1';
    process.env.KORTIX_PROJECT_ID = 'proj_session';
    writeConfig({ devhost: devHost({ token: '' }) });
    enterLinkedDir({
      project_id: 'proj_linked',
      account_id: 'account_1',
      host: 'devhost',
      linked_at: '2026-01-01T00:00:00.000Z',
    });
    const ctx = await resolveContext();
    expect(ctx?.auth.token).toBe(SESSION_TOKEN);
    expect(ctx?.projectId).toBe('proj_linked');
  });
});

// ── Blackbox: the real command modules against a scope-enforcing fake API ───

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

function startFakeApi(
  routes: (req: Request, url: URL, body: unknown, authorization: string | null) => Response | undefined,
): { url: string; requests: RecordedRequest[]; stop(): void } {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const authorization = req.headers.get('authorization');
      let body: unknown = undefined;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        body = await req.json().catch(() => undefined);
      }
      requests.push({ method: req.method, path: url.pathname, body, authorization });
      const res = routes(req, url, body, authorization);
      return res ?? Response.json({ error: `no route for ${req.method} ${url.pathname}` }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

async function runCommand(
  module: string,
  exportName: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const runnerDir = join(tmp, 'runner');
  mkdirSync(runnerDir, { recursive: true });
  const runner = join(runnerDir, 'run.ts');
  writeFileSync(
    runner,
    `import { ${exportName} } from ${JSON.stringify(join(import.meta.dir, '..', 'commands', module))};\n` +
      `const code = await ${exportName}(process.argv.slice(2));\n` +
      `process.exitCode = code;\n` +
      `try { process.stdin.pause(); (process.stdin as { unref?: () => void }).unref?.(); } catch {}\n`,
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_TOKEN: SESSION_TOKEN,
    KORTIX_API_URL: `${process.env.KORTIX_API_URL}`,
    KORTIX_PROJECT_ID: 'proj_session',
    KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
  };
  delete env.BASH_ENV;
  const proc = Bun.spawn({
    cmd: [process.execPath, runner, ...args],
    cwd: opts.cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 20_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

/** Scope rules of the platform's auth middleware, faked: the session-scoped
 *  token may only act on its own project; the personal PAT sees everything. */
function scopeEnforcingRoutes(
  extra: (req: Request, url: URL, body: unknown, authorization: string | null) => Response | undefined,
): (req: Request, url: URL, body: unknown, authorization: string | null) => Response | undefined {
  return (req, url, body, authorization) => {
    const token = authorization?.replace(/^Bearer /, '') ?? '';
    if (token === SESSION_TOKEN && url.pathname.startsWith('/v1/projects/')) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (token === DEV_TOKEN && req.method === 'GET' && url.pathname === '/v1/projects/proj_target') {
      return Response.json(projectRow('proj_target'));
    }
    if (token === DEV_TOKEN && req.method === 'GET' && url.pathname === '/v1/projects/proj_linked') {
      return Response.json(projectRow('proj_linked', 'Linked'));
    }
    if (url.pathname === '/v1/accounts/me') {
      return Response.json({
        user_id: 'user_1',
        email: 'user@example.test',
        accounts: [{ account_id: 'account_1', slug: 'acct', name: 'Acct', role: 'owner' }],
      });
    }
    return extra(req, url, body, authorization);
  };
}

describe('blackbox: the CLI project flow inside a session', () => {
  it('ship --host <name> creates a NEW project instead of shipping the session project', async () => {
    let provision: { url: string; requests: RecordedRequest[]; stop(): void } | null = null;
    const api = startFakeApi(scopeEnforcingRoutes((req, url, body, authorization) => {
      const token = authorization?.replace(/^Bearer /, '') ?? '';
      if (
        token === DEV_TOKEN &&
        req.method === 'POST' &&
        url.pathname === '/v1/projects/provision'
      ) {
        return Response.json({
          ...projectRow('proj_new', 'dogfood-run'),
          push_token: null,
          repo_id: 'repo_1',
          git_origin_url: `${provision!.url}/v1/git/proj_new.git`,
          metadata: { git: { managed: true } },
        }, { status: 201 });
      }
      return undefined;
    }));
    provision = api;
    process.env.KORTIX_API_URL = api.url;
    writeConfig({ devhost: devHost({ url: api.url }) });
    enterProjectDir();

    const res = await runCommand('ship.ts', 'runShip', ['--host', 'devhost', '--no-connect', '--no-env'], { cwd: tmp });
    try {
      const paths = api.requests.map((r) => r.path);
      // First ship must CREATE the project — never adopt the session's project.
      expect(paths).toContain('/v1/projects/provision');
      expect(paths).not.toContain('/v1/projects/proj_session');
      expect(res.stderr).not.toContain('no longer exists');
      // The folder is now bound to the new project on the named host.
      const link = JSON.parse(readFileSync(join(tmp, '.kortix', 'link.json'), 'utf8'));
      expect(link.project_id).toBe('proj_new');
      expect(link.host).toBe('devhost');
    } finally {
      api.stop();
    }
    // The git push itself cannot complete against the fake API; the path
    // under test (which project the ship targets) is already proven above.
  });

  it('projects use <id> falls through the session 403 to the logged-in host', async () => {
    const api = startFakeApi(scopeEnforcingRoutes(() => undefined));
    process.env.KORTIX_API_URL = api.url;
    writeConfig({ devhost: devHost({ url: api.url }) });
    process.chdir(tmp);

    const res = await runCommand('projects.ts', 'runProjects', ['use', 'proj_target'], { cwd: tmp });
    try {
      expect(res.code).toBe(0);
      const config = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'));
      expect(config.hosts.devhost.default_project.project_id).toBe('proj_target');
      expect(res.stderr).not.toContain('Forbidden');
    } finally {
      api.stop();
    }
  });

  it('projects link <id> binds the directory through the logged-in host', async () => {
    const api = startFakeApi(scopeEnforcingRoutes(() => undefined));
    process.env.KORTIX_API_URL = api.url;
    writeConfig({ devhost: devHost({ url: api.url }) });
    enterProjectDir();

    const res = await runCommand('projects.ts', 'runProjects', ['link', 'proj_target'], { cwd: tmp });
    try {
      expect(res.code).toBe(0);
      const link = JSON.parse(readFileSync(join(tmp, '.kortix', 'link.json'), 'utf8'));
      expect(link.project_id).toBe('proj_target');
      expect(link.host).toBe('devhost');
      expect(res.stderr).not.toContain('Forbidden');
    } finally {
      api.stop();
    }
  });

  it('files ls in a linked directory reads the linked project with the PAT', async () => {
    const api = startFakeApi(scopeEnforcingRoutes((req, url) => {
      void req;
      if (url.pathname === '/v1/projects/proj_linked/files') {
        return Response.json([{ path: 'README.md', type: 'file', size: 12 }]);
      }
      return undefined;
    }));
    process.env.KORTIX_API_URL = api.url;
    writeConfig({ devhost: devHost({ url: api.url }) });
    enterLinkedDir({
      project_id: 'proj_linked',
      account_id: 'account_1',
      host: 'devhost',
      linked_at: '2026-01-01T00:00:00.000Z',
    });

    const res = await runCommand('files.ts', 'runFiles', ['ls'], { cwd: tmp });
    try {
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('README.md');
      expect(res.stderr).not.toContain('Not found');
    } finally {
      api.stop();
    }
  });
});
