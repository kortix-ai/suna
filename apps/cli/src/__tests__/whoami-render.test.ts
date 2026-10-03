import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

// Characterization of `kortix whoami`'s two HUMAN-facing renderings, black-box
// against a real local API: the `--token-only` block and the human summary's
// token block, byte for byte (stdout is a pipe here, so every style code is
// empty and the bytes below are the literal output).
//
// The two renderings drifted on the fallback token-kind spelling — the
// --token-only header says `user token`, the human summary's `token` line says
// `token` — so both are pinned here before the rendering code is shared.

const CLI_ENTRY = resolve(import.meta.dir, '..', 'index.ts');

const HOST_NAME = 'test';
const EMAIL = 'owner@example.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

const ACCOUNTS = [
  { account_id: ACCOUNT_ID, slug: 'acme', name: 'Acme', role: 'owner' },
  { account_id: 'bbbbbbbb-2222-4222-8222-222222222222', slug: 'beta', name: 'Beta', role: 'member' },
];

// One /accounts/me payload per bearer token, so every case gets its own
// throwaway config and the cases can run concurrently.
const ME_BY_TOKEN: Record<string, unknown> = {
  // A session-scoped token: every token-context line renders in both modes.
  kortix_pat_render_session: {
    user_id: USER_ID,
    email: EMAIL,
    token_context: {
      auth_type: 'session',
      project_id: 'proj_1',
      session_id: 'sess_1',
      agent: 'reviewer',
      connectors: ['projects:read', 'files:read'],
      kortix_permissions: ['projects:read'],
      kortix_cli: ['projects:read'],
      env: 'all',
    },
    accounts: ACCOUNTS,
  },
  // A plain PAT: no project/session/agent, so the human summary renders NO
  // token block at all, while --token-only still prints its header.
  kortix_pat_render_pat: {
    user_id: USER_ID,
    email: EMAIL,
    token_context: {
      auth_type: 'pat',
      project_id: null,
      session_id: null,
      agent: null,
      connectors: [],
      kortix_permissions: ['projects:read'],
      kortix_cli: ['projects:read'],
      env: ['KORTIX_API_URL'],
    },
    accounts: ACCOUNTS,
  },
  // An agent token with no auth_type: the only shape that reaches the
  // fallback kind — `user token` on --token-only, plain `token` in the human
  // summary. This is the pair of spellings the shared renderer must keep.
  kortix_pat_render_agent: {
    user_id: USER_ID,
    email: EMAIL,
    token_context: {
      auth_type: null,
      project_id: null,
      session_id: null,
      agent: 'reviewer',
      connectors: 'all',
      kortix_permissions: null,
      kortix_cli: null,
    },
    accounts: ACCOUNTS,
  },
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let apiPort = 0;

function startApi(): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const me = ME_BY_TOKEN[(req.headers.get('authorization') ?? '').replace('Bearer ', '')];
      if (!me) return Response.json({ error: 'unauthenticated' }, { status: 401 });
      if (new URL(req.url).pathname.endsWith('/accounts/me')) return Response.json(me);
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  // `Server.port` is `number | undefined` in @types/bun (unix sockets); a TCP
  // server on an ephemeral port always has one. `?? 0` degrades to a loud
  // connection-refused failure, never a silently wrong assertion.
  apiPort = server.port ?? 0;
}

/** A throwaway HOME + config pointing the active host at the local API. */
function seedConfig(token: string): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-whoami-render-'));
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      active: HOST_NAME,
      hosts: {
        [HOST_NAME]: {
          url: `http://127.0.0.1:${apiPort}/v1`,
          token,
          user_id: USER_ID,
          user_email: EMAIL,
          account_id: ACCOUNT_ID,
          default_project: { project_id: 'proj_def', account_id: ACCOUNT_ID, name: 'Def Project' },
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  );
  return { dir, config };
}

function childEnv(dir: string, config: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_SESSION_ID',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  return env;
}

async function runCli(args: string[], dir: string, config: string): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: dir,
    env: childEnv(dir, config),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

describe('whoami renderings (human + --token-only) are byte-stable', () => {
  const results = new Map<string, CliResult>();
  const dirs: string[] = [];

  beforeAll(async () => {
    startApi();
    // One throwaway config per case: the cases run concurrently and must not
    // share a directory one of them would clean up under another.
    const cases: Array<[string, string[], string]> = [
      ['token-only session', ['whoami', '--token-only'], 'kortix_pat_render_session'],
      ['token-only pat', ['whoami', '--token-only'], 'kortix_pat_render_pat'],
      ['token-only agent', ['whoami', '--token-only'], 'kortix_pat_render_agent'],
      ['human session', ['whoami'], 'kortix_pat_render_session'],
      ['human agent', ['whoami'], 'kortix_pat_render_agent'],
      ['human pat', ['whoami'], 'kortix_pat_render_pat'],
    ];
    await Promise.all(
      cases.map(async ([name, args, token]) => {
        const { dir, config } = seedConfig(token);
        dirs.push(dir);
        results.set(name, await runCli(args, dir, config));
      }),
    );
  }, 120_000);

  afterAll(() => {
    server?.stop(true);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const get = (name: string): CliResult => {
    const result = results.get(name);
    if (!result) throw new Error(`case not run: ${name}`);
    return result;
  };

  test('--token-only: a session token renders the whole block, byte for byte', () => {
    const { code, stdout } = get('token-only session');
    expect(code).toBe(0);
    expect(stdout).toBe(
      '\n' +
        '  session token\n' +
        '  project   proj_1\n' +
        '  session   sess_1\n' +
        '  agent     reviewer\n' +
        '  connectors projects:read, files:read\n' +
        '  permissions projects:read\n' +
        '  env       all\n' +
        '\n',
    );
  });

  test('--token-only: a plain PAT renders its auth_type as the kind', () => {
    const { code, stdout } = get('token-only pat');
    expect(code).toBe(0);
    expect(stdout).toBe(
      '\n' +
        '  pat\n' +
        '  connectors none\n' +
        '  permissions projects:read\n' +
        '  env       KORTIX_API_URL\n' +
        '\n',
    );
  });

  test('--token-only: no auth_type falls back to the "user token" spelling', () => {
    const { code, stdout } = get('token-only agent');
    expect(code).toBe(0);
    expect(stdout).toBe('\n  user token\n  agent     reviewer\n  connectors all\n\n');
  });

  test('human mode: the summary carries identity, account, default project and host', () => {
    const { code, stdout } = get('human session');
    expect(code).toBe(0);
    expect(stdout).toContain(`\n  ${EMAIL}\n`);
    expect(stdout).toContain(`  email     ${EMAIL}\n`);
    expect(stdout).toContain(`  user_id   ${USER_ID}\n`);
    expect(stdout).toContain('  account   Acme (acme, owner)\n');
    expect(stdout).toContain('  2 accounts total — switch with kortix accounts use <slug>\n');
    expect(stdout).toContain('  project   Def Project (default)\n');
    expect(stdout).toContain(`  host      ${HOST_NAME} (http://127.0.0.1:${apiPort}/v1)\n`);
    expect(stdout).toMatch(/hosts configured — list with `kortix hosts ls`\n/);
  });

  test('human mode: a session token renders the token block without permissions/env', () => {
    const { stdout } = get('human session');
    expect(stdout).toContain('  token     session token\n');
    expect(stdout).toContain('  project   proj_1\n');
    expect(stdout).toContain('  session   sess_1\n');
    expect(stdout).toContain('  agent     reviewer\n');
    expect(stdout).toContain('  connectors projects:read, files:read\n');
    expect(stdout).not.toContain('  permissions ');
    expect(stdout).not.toContain('  env       ');
  });

  test('human mode: no auth_type falls back to the bare "token" spelling', () => {
    const { stdout } = get('human agent');
    expect(stdout).toContain('  token     token\n');
    expect(stdout).toContain('  agent     reviewer\n');
    expect(stdout).toContain('  connectors all\n');
    expect(stdout).not.toContain('user token');
    expect(stdout).not.toContain('  permissions ');
  });

  test('human mode: a plain PAT renders no token block at all', () => {
    const { code, stdout } = get('human pat');
    expect(code).toBe(0);
    expect(stdout).not.toContain('  token     ');
    expect(stdout).not.toContain('  permissions ');
  });
});
