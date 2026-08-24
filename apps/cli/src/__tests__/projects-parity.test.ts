/**
 * Blackbox parity coverage for the `kortix projects` write surfaces that used
 * to be dashboard-only — `set` / `rename` (PATCH /projects/:id), `cli-tokens`
 * (GET/POST/DELETE /projects/:id/cli-token) and `upgrade` (the Customize →
 * Upgrades session) — plus `ls --query` and `files download`.
 *
 * Every case spawns the real CLI against a Bun.serve fake API and asserts the
 * exit code, the stdout/stderr the user sees, AND the exact method + path +
 * body the CLI put on the wire. Same shape as projects-features.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_parity';

/** Four bytes of a real zip local-file header — enough to prove the CLI wrote
 *  the response body through byte-for-byte instead of re-encoding it. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);

interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
  authorization: string | null;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
/** Per-path status overrides so one test can drive an error branch. */
let failWith: Record<string, { status: number; body: unknown }> = {};

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_parity',
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

function project(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT,
    account_id: 'account_1',
    name: 'Parity',
    repo_url: 'https://example.test/parity.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    icon: null,
    icon_glyph: null,
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    dashboard_url: `https://app.example.test/projects/${PROJECT}`,
    ...overrides,
  };
}

async function readBody(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = await readBody(req);
      calls.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        body,
        authorization: req.headers.get('authorization'),
      });

      const override = failWith[`${req.method} ${url.pathname}`];
      if (override) return Response.json(override.body, { status: override.status });

      // PATCH /v1/projects/:id — echo the request back as the updated row so
      // the CLI's "what did it become" output is driven by the real payload.
      if (url.pathname === `/v1/projects/${PROJECT}` && req.method === 'PATCH') {
        const patch = (body ?? {}) as Record<string, unknown>;
        return Response.json(
          project({
            ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
            ...(typeof patch.default_branch === 'string'
              ? { default_branch: patch.default_branch }
              : {}),
            ...(typeof patch.manifest_path === 'string'
              ? { manifest_path: patch.manifest_path }
              : {}),
            icon: 'icon' in patch ? patch.icon : null,
            icon_glyph: 'icon_glyph' in patch ? patch.icon_glyph : null,
          }),
        );
      }
      if (url.pathname === '/v1/projects' && req.method === 'GET') {
        return Response.json([
          project(),
          project({ project_id: 'proj_other', name: 'Other', repo_url: 'https://example.test/o.git' }),
        ]);
      }
      if (url.pathname === `/v1/projects/${PROJECT}/cli-token` && req.method === 'GET') {
        return Response.json({
          items: [
            {
              token_id: 'tok_1',
              name: 'cli · Parity',
              public_key: 'kortix_pk_1',
              status: 'active',
              expires_at: null,
              last_used_at: null,
              created_at: '2026-01-01T00:00:00.000Z',
              revoked_at: null,
            },
          ],
        });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/cli-token` && req.method === 'POST') {
        const name = ((body ?? {}) as { name?: string }).name ?? 'cli · Parity';
        return Response.json(
          {
            token_id: 'tok_new',
            name,
            public_key: 'kortix_pk_new',
            secret_key: 'kortix_pat_supersecret',
            status: 'active',
            project_id: PROJECT,
            expires_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
          },
          { status: 201 },
        );
      }
      if (
        url.pathname === `/v1/projects/${PROJECT}/cli-token/tok_1` &&
        req.method === 'DELETE'
      ) {
        return Response.json({ ok: true });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/sessions` && req.method === 'POST') {
        return Response.json({ session_id: 'sess_upgrade' }, { status: 201 });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/files/archive` && req.method === 'GET') {
        return new Response(ZIP_BYTES, {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
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
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'BASH_ENV',
  ]) {
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

function callsTo(method: string, path: string): Call[] {
  return calls.filter((c) => c.method === method && c.path === path);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-projects-parity-'));
  process.env = { ...ORIGINAL_ENV };
  calls = [];
  failWith = {};
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe('kortix projects set / rename', () => {
  test('--help documents every field and the three-state icon rule', async () => {
    const r = await runCli(['projects', 'set', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--manifest <path>');
    expect(r.stdout).toContain('--no-glyph');
    expect(r.stdout).toContain('project.customize.write');
  });

  test('writes only the fields passed', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['projects', 'set', '--project', PROJECT, '--name', 'Renamed', '--branch', 'trunk'],
      config,
    );
    expect(r.code).toBe(0);
    expect(callsTo('PATCH', `/v1/projects/${PROJECT}`)[0].body).toEqual({
      name: 'Renamed',
      default_branch: 'trunk',
    });
    expect(r.stdout).toContain('Updated Renamed');
    expect(r.stdout).toContain('branch   trunk');
  });

  test('--icon sets the emoji; --no-icon sends an explicit null', async () => {
    const config = writeConfig(startServer());
    const set = await runCli(['projects', 'set', '--project', PROJECT, '--icon', '🚀'], config);
    expect(set.code).toBe(0);
    expect(callsTo('PATCH', `/v1/projects/${PROJECT}`)[0].body).toEqual({ icon: '🚀' });
    expect(set.stdout).toContain('icon     🚀');

    calls = [];
    const clear = await runCli(['projects', 'set', '--project', PROJECT, '--no-icon'], config);
    expect(clear.code).toBe(0);
    expect(callsTo('PATCH', `/v1/projects/${PROJECT}`)[0].body).toEqual({ icon: null });
    expect(clear.stdout).toContain('icon     (none)');
  });

  test('--glyph <name>:<color> sends the icon_glyph object; --no-glyph nulls it', async () => {
    const config = writeConfig(startServer());
    const set = await runCli(
      ['projects', 'set', '--project', PROJECT, '--glyph', 'Rocket:blue', '--json'],
      config,
    );
    expect(set.code).toBe(0);
    expect(callsTo('PATCH', `/v1/projects/${PROJECT}`)[0].body).toEqual({
      icon_glyph: { name: 'Rocket', color: 'blue' },
    });
    expect(JSON.parse(set.stdout).icon_glyph).toEqual({ name: 'Rocket', color: 'blue' });

    calls = [];
    const clear = await runCli(['projects', 'set', '--project', PROJECT, '--no-glyph'], config);
    expect(clear.code).toBe(0);
    expect(callsTo('PATCH', `/v1/projects/${PROJECT}`)[0].body).toEqual({ icon_glyph: null });
  });

  test('an unknown glyph name or color is refused locally, with no request sent', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'set', '--project', PROJECT, '--glyph', 'Nope:blue'], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Invalid --glyph');
    expect(calls).toEqual([]);
  });

  test('--icon together with --glyph is refused (a project shows one icon)', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['projects', 'set', '--project', PROJECT, '--icon', '🚀', '--glyph', 'Rocket:blue'],
      config,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not both');
    expect(calls).toEqual([]);
  });

  test('no field at all exits 2 with usage and issues no write', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'set', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('set requires at least one field');
    expect(calls).toEqual([]);
  });

  test('rename <id> <name> PATCHes just the name', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'rename', PROJECT, 'Fresh Name'], config);
    expect(r.code).toBe(0);
    expect(callsTo('PATCH', `/v1/projects/${PROJECT}`)[0].body).toEqual({ name: 'Fresh Name' });
    expect(r.stdout).toContain('Updated Fresh Name');
  });

  test('rename with no name exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'rename', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('rename takes');
  });

  test('a 403 from the API surfaces the server message and exits 1', async () => {
    const config = writeConfig(startServer());
    failWith[`PATCH /v1/projects/${PROJECT}`] = {
      status: 403,
      body: { error: 'customize.write required on this project' },
    };
    const r = await runCli(['projects', 'set', '--project', PROJECT, '--name', 'X'], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('customize.write required on this project');
  });
});

describe('kortix projects cli-tokens', () => {
  test('--help names the routes permission and the print-once rule', async () => {
    const r = await runCli(['projects', 'cli-tokens', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('project.credentials.issue');
    expect(r.stdout).toContain('printed ONCE');
  });

  test('ls lists the project tokens; --json emits the raw rows', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'cli-tokens', 'ls', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(callsTo('GET', `/v1/projects/${PROJECT}/cli-token`).length).toBe(1);
    expect(r.stdout).toContain('tok_1');
    expect(r.stdout).toContain('cli · Parity');

    calls = [];
    const j = await runCli(['projects', 'cli-tokens', '--project', PROJECT, '--json'], config);
    expect(j.code).toBe(0);
    const rows = JSON.parse(j.stdout) as Array<{ token_id: string }>;
    expect(rows.map((t) => t.token_id)).toEqual(['tok_1']);
  });

  test('new POSTs {name} and prints the secret exactly once', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['projects', 'cli-tokens', 'new', '--project', PROJECT, '--name', 'laptop'],
      config,
    );
    expect(r.code).toBe(0);
    expect(callsTo('POST', `/v1/projects/${PROJECT}/cli-token`)[0].body).toEqual({ name: 'laptop' });
    expect(r.stdout).toContain('kortix_pat_supersecret');
    expect(r.stdout.match(/kortix_pat_supersecret/g)?.length).toBe(1);
    expect(r.stdout).toContain('shown once');
  });

  test('new without --name posts an empty body so the server names it', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'cli-tokens', 'new', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(callsTo('POST', `/v1/projects/${PROJECT}/cli-token`)[0].body).toEqual({});
  });

  test('rm -y DELETEs the token id', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['projects', 'cli-tokens', 'rm', 'tok_1', '--project', PROJECT, '-y'],
      config,
    );
    expect(r.code).toBe(0);
    expect(callsTo('DELETE', `/v1/projects/${PROJECT}/cli-token/tok_1`).length).toBe(1);
    expect(r.stdout).toContain('Revoked tok_1');
  });

  test('rm without a token id exits 2 and deletes nothing', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'cli-tokens', 'rm', '--project', PROJECT, '-y'], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('requires a <token-id>');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  test('a 403 (agent-session token) surfaces the server message and exits 1', async () => {
    const config = writeConfig(startServer());
    failWith[`POST /v1/projects/${PROJECT}/cli-token`] = {
      status: 403,
      body: { error: 'Agent-session tokens cannot mint project tokens' },
    };
    const r = await runCli(['projects', 'cli-tokens', 'new', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Agent-session tokens cannot mint project tokens');
  });
});

describe('kortix projects upgrade', () => {
  test('--help explains that it opens a change request and never merges', async () => {
    const r = await runCli(['projects', 'upgrade', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kortix.yaml');
    expect(r.stdout).toContain('never');
  });

  test('creates a session seeded with the v1→v2 migration prompt', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'upgrade', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const [call] = callsTo('POST', `/v1/projects/${PROJECT}/sessions`);
    const body = call.body as {
      initial_prompt: string;
      name: string;
      metadata: Record<string, unknown>;
    };
    expect(body.name).toBe('Migrate manifest to v2');
    expect(body.metadata).toEqual({ kind: 'project-upgrade', upgrade_id: 'manifest-v2' });
    expect(body.initial_prompt).toContain(
      "Migrate this project's manifest from kortix_version 1",
    );
    // The landing contract is the load-bearing half of the prompt.
    expect(body.initial_prompt).toContain('kortix cr open');
    expect(body.initial_prompt).toContain('Do **not** run `kortix cr merge`');
    expect(r.stdout).toContain('sess_upgrade');
    expect(r.stdout).toContain('kortix connect sess_upgrade');
  });

  test('the seeded prompt is byte-identical to the dashboard\'s', async () => {
    const webPrompt = readFileSync(
      resolve(
        CLI_ROOT,
        '..',
        'web',
        'src',
        'features',
        'workspace',
        'customize',
        'migrate-to-v2',
        'migration-prompt.ts',
      ),
      'utf8',
    );
    const marker = 'export const MIGRATE_TO_V2_PROMPT = `';
    const start = webPrompt.indexOf(marker) + marker.length;
    const end = webPrompt.lastIndexOf('`;');
    // Unescape the template literal the same way the runtime does.
    const expected = webPrompt.slice(start, end).replaceAll('\\`', '`').replaceAll('\\$', '$');

    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'upgrade', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const body = callsTo('POST', `/v1/projects/${PROJECT}/sessions`)[0].body as {
      initial_prompt: string;
    };
    expect(body.initial_prompt).toBe(expected);
  });

  test('--json emits the session and project ids', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'upgrade', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      session_id: 'sess_upgrade',
      project_id: PROJECT,
      upgrade_id: 'manifest-v2',
    });
  });
});

describe('kortix projects ls --query', () => {
  test('filters the fetched list by name, id or repo', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'ls', '--query', 'other', '--json'], config);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ project_id: string }>;
    expect(rows.map((p) => p.project_id)).toEqual(['proj_other']);
  });

  test('a query that matches nothing says so and still exits 0', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'ls', '--query', 'zzz-nothing'], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('match "zzz-nothing"');
  });

  test('--query with no value exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'ls', '--query'], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--query requires a value');
  });
});

describe('kortix files download', () => {
  test('--help documents -o and the scoped-out-subtree refusal', async () => {
    const r = await runCli(['files', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('download -o <out.zip>');
    expect(r.stdout).toContain('-o, --out <file>');
    expect(r.stdout).toContain('project.file.read');
  });

  test('streams the zip to -o and passes --ref/--path through as query params', async () => {
    const config = writeConfig(startServer());
    const out = join(tmp, 'nested', 'workspace.zip');
    const r = await runCli(
      [
        'files',
        'download',
        '--project',
        PROJECT,
        '--ref',
        'feature/x',
        '--path',
        '.kortix',
        '-o',
        out,
      ],
      config,
    );
    expect(r.code).toBe(0);
    const [call] = callsTo('GET', `/v1/projects/${PROJECT}/files/archive`);
    expect(call.search).toBe('?ref=feature%2Fx&path=.kortix');
    expect(call.authorization).toBe('Bearer tok_parity');
    // Byte-for-byte, and the parent directory was created for us.
    expect(new Uint8Array(readFileSync(out))).toEqual(ZIP_BYTES);
    expect(r.stdout).toContain('Wrote');
  });

  test('without --ref the request carries no ref param', async () => {
    const config = writeConfig(startServer());
    const out = join(tmp, 'w.zip');
    const r = await runCli(['files', 'download', '--project', PROJECT, '-o', out], config);
    expect(r.code).toBe(0);
    expect(callsTo('GET', `/v1/projects/${PROJECT}/files/archive`)[0].search).toBe('');
  });

  test('--json reports the written path and byte count', async () => {
    const config = writeConfig(startServer());
    const out = join(tmp, 'w.zip');
    const r = await runCli(
      ['files', 'download', '--project', PROJECT, '-o', out, '--json'],
      config,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      path: out,
      bytes: ZIP_BYTES.byteLength,
      ref: null,
      subtree: null,
    });
  });

  test('without -o it exits 2 and downloads nothing', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['files', 'download', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('-o <out.zip>');
    expect(calls).toEqual([]);
  });

  test('a 403 on a scoped-out subtree surfaces the server message and exits 1', async () => {
    const config = writeConfig(startServer());
    failWith[`GET /v1/projects/${PROJECT}/files/archive`] = {
      status: 403,
      body: {
        error:
          'This folder includes agents or skills you are not allowed to access. Archive a more specific path instead.',
      },
    };
    const r = await runCli(
      ['files', 'download', '--project', PROJECT, '-o', join(tmp, 'w.zip')],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Archive a more specific path instead');
  });
});
