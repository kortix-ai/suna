import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The CLI help + error-routing accuracy contract, black-box: a real CLI
// process against a recording local API. One test per defect the dogfood
// journeys hit (KRTX-2710 and its members):
//   KRTX-2620  `sandboxes` with no subcommand names the missing subcommand
//              instead of reporting a flag as `unknown subcommand`
//   KRTX-2603  a leading global flag is honored, never "unknown command"
//   KRTX-2604  `kortix help <topic>` prints the topic's own help
//   KRTX-1802  `kortix token --help` documents the token command
//   KRTX-2075  the install-failure session hint only appears when a session
//              was created
//   KRTX-1914  `connectors policy --help` is focused and the stale
//              local-file claim is gone

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };

const ME = {
  user_id: '11111111-1111-4111-8111-111111111111',
  email: 'worker@example.test',
  token_context: {
    auth_type: 'pat',
    project_id: 'cccccccc-3333-4333-8333-333333333333',
    session_id: null,
    agent: null,
    kortix_permissions: ['project.session.read'],
  },
  accounts: [
    {
      account_id: 'aaaaaaaa-1111-4111-8111-111111111111',
      slug: 'acme',
      name: 'Acme',
      role: 'owner',
    },
  ],
};

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let apiBase = '';
/** The POST …/marketplace/install-session answer the recorder serves. */
let installSession: { status: number; body: unknown } = {
  status: 201,
  body: { session_id: 'session-install' },
};
/** When non-200, GET …/turn answers with this status (a mid-poll failure). */
let turnStatus = 200;

function writeConfig(): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_help',
          user_id: ME.user_id,
          user_email: ME.email,
          account_id: 'aaaaaaaa-1111-4111-8111-111111111111',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: writeConfig(),
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
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(9), 15_000);
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

beforeAll(() => {
  process.env = { ...ORIGINAL_ENV };
  tmp = mkdtempSync(join(tmpdir(), 'kortix-help-accuracy-'));
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      if (pathname.endsWith('/accounts/me')) return Response.json(ME);
      if (pathname.endsWith('/marketplace/install-session')) {
        if (req.method !== 'POST')
          return Response.json({ error: 'method not allowed' }, { status: 405 });
        return Response.json(installSession.body, { status: installSession.status });
      }
      if (pathname.endsWith('/turn')) {
        if (turnStatus !== 200)
          return Response.json({ error: 'turn exploded' }, { status: turnStatus });
        return Response.json({
          turns: [],
          last_ended: { turn_token: 'turn-help', end_reason: 'completed', error: null },
        });
      }
      if (pathname.endsWith('/prompts')) return Response.json({ prompts: [] });
      if (pathname.endsWith('/sessions/session-install'))
        return Response.json({ status: 'running', error: null });
      return Response.json({ error: 'not recorded' }, { status: 404 });
    },
  });
  apiBase = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe('KRTX-2620: sandboxes with no subcommand', () => {
  test('a leading flag reports the missing subcommand, not `unknown subcommand`', async () => {
    const r = await runCli(['sandboxes', '--host', 'host-run']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing subcommand');
    expect(r.stderr).not.toContain('unknown subcommand');
    // The usage block still prints with it.
    expect(r.stderr).toContain('Usage: kortix sandboxes');
  });
});

describe('KRTX-2603: a leading global flag in command position', () => {
  test('`--host <name>` before the group is honored: the group help prints', async () => {
    const r = await runCli(['--host', 'host-run', 'sandboxes', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: kortix sandboxes');
    expect(r.stderr).not.toContain('unknown command');
  });

  test('`--host <name>` before the group reaches the subcommand parser', async () => {
    // `sandboxes ls` never runs (no auth on the recorder) — the point is the
    // ERROR is no longer about the flag: an unknown host is the CLI's own
    // connection error, not `unknown command "--host"`.
    const r = await runCli(['--host', 'host-run', 'sandboxes', 'ls', '--json']);
    expect(r.stderr).not.toContain('unknown command');
    expect(r.stderr).not.toContain('unknown subcommand');
  });

  test('an unknown leading flag names the option instead of `unknown command`', async () => {
    const r = await runCli(['--bogus-flag', 'sandboxes', 'ls']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown option `--bogus-flag`');
    expect(r.stderr).not.toContain('unknown command');
    expect(r.stderr).toContain('kortix --help');
  });
});

describe('KRTX-2604: `kortix help <topic>`', () => {
  test('a known topic prints the topic help, not the landing screen', async () => {
    const r = await runCli(['help', 'sessions']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: kortix sessions');
    expect(r.stdout).not.toContain('Kortix CLI');
  });

  test('an unknown topic exits nonzero and names the topic', async () => {
    const r = await runCli(['help', 'nosuchtopic']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown help topic `nosuchtopic`');
    expect(r.stdout).not.toContain('Kortix CLI');
  });

  test('bare `kortix help` keeps the landing screen', async () => {
    const r = await runCli(['help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Kortix CLI');
  });
});

describe('KRTX-1802: `kortix token --help`', () => {
  test('documents the token command, not whoami', async () => {
    const r = await runCli(['token', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: kortix token');
    expect(r.stdout).not.toContain('Usage: kortix whoami');
  });

  test('bare `kortix token` still prints the token context', async () => {
    const r = await runCli(['token']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('project token');
    expect(r.stdout).toContain(ME.token_context.project_id);
  });
});

describe('KRTX-2075: marketplace install error hint', () => {
  test('a 400 before any session exists names the cause without the session hint', async () => {
    installSession = { status: 400, body: { error: 'Unknown item "test:pdf"' } };
    try {
      const r = await runCli([
        'marketplace',
        'install',
        'test:pdf',
        '--project',
        'project-test',
        '--json',
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Unknown item "test:pdf"');
      expect(r.stderr).not.toContain('Inspect the session');
    } finally {
      installSession = { status: 201, body: { session_id: 'session-install' } };
    }
  });

  test('a 402 plan gate names the plan cause without the session hint', async () => {
    installSession = {
      status: 402,
      body: {
        error:
          'Marketplace installs run an agent import that needs a model. This plan does not include managed models.',
        code: 'no_servable_model',
      },
    };
    try {
      const r = await runCli([
        'marketplace',
        'install',
        'test:pdf',
        '--project',
        'project-test',
        '--json',
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('plan does not include managed models');
      expect(r.stderr).not.toContain('Inspect the session');
    } finally {
      installSession = { status: 201, body: { session_id: 'session-install' } };
    }
  });

  test('a failure after the session was created keeps the session hint', async () => {
    turnStatus = 500;
    try {
      const r = await runCli([
        'marketplace',
        'install',
        'test:pdf',
        '--project',
        'project-test',
        '--json',
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('in session session-install');
      expect(r.stderr).toContain('Inspect the session before retrying.');
    } finally {
      turnStatus = 200;
    }
  });
});

describe('KRTX-1914: connectors policy help', () => {
  test('`connectors policy --help` prints focused policy help', async () => {
    const r = await runCli(['connectors', 'policy', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: kortix connectors policy');
    // Focused: a small page, not the ~166-line connectors parent help.
    expect(r.stdout.split('\n').length).toBeLessThan(50);
    // The four per-connector forms and the cloud-side semantics are named.
    expect(r.stdout).toContain('<slug> set <match> <action>');
    expect(r.stdout).toContain('<slug> clear');
    expect(r.stdout).toContain('applies now');
    expect(r.stdout).not.toContain('edit your LOCAL file');
  });

  test('the connectors parent help drops the stale local-file claim', async () => {
    const r = await runCli(['connectors', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('Only credentials, OAuth, and reads talk to the cloud');
    expect(r.stdout).toContain('policy set --default');
  });
});
