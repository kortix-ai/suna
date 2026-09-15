import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Two things the dev e2e pass surfaced, both fixed in one place each:
//  1. a manifest compare-and-swap 409 ("File "kortix.yaml" changed since it was
//     read") right after a previous manifest commit — the CLI now replays the
//     write once (apps/cli/src/api/client.ts).
//  2. `kortix projects ls` ignored `--host`, so it always listed the ACTIVE
//     host's account — now `--host` / `--account` are honored.

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_cas';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let hits: Array<{ method: string; path: string; query: string }> = [];

function writeConfig(activeBase: string, otherBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'active-host',
      hosts: {
        'active-host': {
          url: activeBase,
          token: 'tok_active',
          user_id: 'u1',
          user_email: 'a@example.test',
          account_id: 'acct_active',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
        'other-host': {
          url: otherBase,
          token: 'tok_other',
          user_id: 'u1',
          user_email: 'a@example.test',
          account_id: 'acct_other',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

function startServer(): string {
  let scopePuts = 0;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      hits.push({ method: req.method, path: url.pathname, query: url.search });
      if (url.pathname === `/v1/projects/${PROJECT}/agents/bot/scope` && req.method === 'PUT') {
        scopePuts += 1;
        if (scopePuts === 1) {
          return Response.json({ error: 'File "kortix.yaml" changed since it was read' }, { status: 409 });
        }
        return Response.json({ ok: true, agent: 'bot', env: 'all', connectors: [], connectors_required: [] });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/agents/bot/config` && req.method === 'GET') {
        return Response.json({ agent: 'bot', schema_version: 2, editable: true, block: { secrets: 'all', connectors: [] } });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/features` && req.method === 'PATCH') {
        // A CAS-looking 409 on a NON-manifest route is replayed too (same
        // message = same server contract), but a different 409 is not.
        return Response.json({ error: 'enabled must be a boolean or null' }, { status: 409 });
      }
      if (url.pathname === '/v1/projects' && req.method === 'GET') {
        const acct = url.searchParams.get('account_id');
        return Response.json([
          { project_id: `p_${acct}`, account_id: acct, name: `Project of ${acct}`, repo_url: '', default_branch: 'main', manifest_path: 'kortix.yaml', status: 'active', last_opened_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
        ]);
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
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) delete env[key];
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: tmp, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill(), 20_000);
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('CLI client: manifest CAS 409 is replayed once', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-cas-'));
    process.env = { ...ORIGINAL_ENV };
    hits = [];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('agents scope: first PUT answers the CAS 409, the replay succeeds → exit 0', async () => {
    const base = startServer();
    const config = writeConfig(base, base);
    const r = await runCli(['agents', 'scope', 'bot', '--secrets', 'all', '--connectors', 'none', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const puts = hits.filter((h) => h.method === 'PUT' && h.path.endsWith('/agents/bot/scope'));
    expect(puts.length).toBe(2);
    expect(r.stderr).not.toContain('changed since it was read');
  });

  test('a 409 with a different message is NOT replayed', async () => {
    const base = startServer();
    const config = writeConfig(base, base);
    const r = await runCli(['projects', 'features', 'enable', 'apps', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    const patches = hits.filter((h) => h.method === 'PATCH');
    expect(patches.length).toBe(1);
  });
});

describe('kortix projects ls honors --host / --account', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-ls-host-'));
    process.env = { ...ORIGINAL_ENV };
    hits = [];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--host other-host lists THAT host’s account, --account overrides it', async () => {
    const base = startServer();
    const config = writeConfig('http://127.0.0.1:9', base); // active host is unreachable on purpose
    const r = await runCli(['projects', 'ls', '--host', 'other-host', '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].project_id).toBe('p_acct_other');
    const r2 = await runCli(['projects', 'ls', '--host', 'other-host', '--account', 'acct_x', '--json'], config);
    expect(r2.code).toBe(0);
    expect(JSON.parse(r2.stdout)[0].project_id).toBe('p_acct_x');
    expect(hits.filter((h) => h.path === '/v1/projects').map((h) => h.query)).toEqual(['?account_id=acct_other', '?account_id=acct_x']);
  });

  test('--host that is not logged in exits 1 with a login hint', async () => {
    const base = startServer();
    const config = writeConfig(base, base);
    const r = await runCli(['projects', 'ls', '--host', 'nope-host'], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
  });
});
