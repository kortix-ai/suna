/**
 * Black-box guards for bare `kortix` (R-40). Every invocation here runs the
 * real CLI as a child process with piped stdio — i.e. NOT a TTY, which is
 * exactly how CI, shell scripts, and agents call it. The picker must stay out
 * of their way completely.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const SANDBOX_ENV_OVERRIDES = [
  'KORTIX_API_URL',
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_TOKEN',
  'BASH_ENV',
] as const;

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: string[] = [];

function writeConfig(apiBase: string, withDefaultProject: boolean): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_picker',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          default_project: withDefaultProject
            ? { project_id: 'proj_picker', account_id: 'account_1', name: 'yo' }
            : undefined,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

function startDetailServer() {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/v1/projects/proj_picker/detail') {
        return Response.json({
          project: { name: 'yo' },
          config: {
            agents: [
              {
                name: 'kortix-agi',
                path: 'kortix://platform/agents/kortix-agi.md',
                description: 'Kortix AGI — the control agent.',
                mode: 'primary',
                source: 'platform',
                enabled: true,
                platform_owned: true,
              },
              {
                name: 'kortix',
                path: '.kortix/opencode/agents/kortix.md',
                description: null,
                mode: 'primary',
                enabled: true,
              },
            ],
          },
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
  };
  for (const key of SANDBOX_ENV_OVERRIDES) delete env[key];
  Object.assign(env, extraEnv);
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    // A pipe on stdin is the whole point: a prompt here would hang forever.
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('bare `kortix` on a non-TTY', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-bare-'));
    requests = [];
    process.env = { ...ORIGINAL_ENV };
    for (const key of SANDBOX_ENV_OVERRIDES) delete process.env[key];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('signed in with a linked project, it prints the banner and never opens a picker', async () => {
    const apiBase = startDetailServer();
    const configFile = writeConfig(apiBase, true);

    const result = await runCli([], { KORTIX_CONFIG_FILE: configFile });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The operating system for AI workers');
    expect(result.stdout).toContain('Where you are');
    expect(result.stdout).not.toContain('pick an agent');
    // Short-circuited before any I/O — the roster is never even fetched.
    expect(requests).toEqual([]);
  }, 20_000);

  test('its output is byte-identical to `kortix --help`', async () => {
    const apiBase = startDetailServer();
    const configFile = writeConfig(apiBase, true);

    const bare = await runCli([], { KORTIX_CONFIG_FILE: configFile });
    const helpFlag = await runCli(['--help'], { KORTIX_CONFIG_FILE: configFile });
    const helpWord = await runCli(['help'], { KORTIX_CONFIG_FILE: configFile });

    expect(bare.stdout).toBe(helpFlag.stdout);
    expect(helpWord.stdout).toBe(helpFlag.stdout);
    expect(helpFlag.code).toBe(0);
  }, 30_000);

  test('signed out, it still prints the banner instead of erroring', async () => {
    const result = await runCli([], { KORTIX_CONFIG_FILE: join(tmp, 'missing-config.json') });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The operating system for AI workers');
    expect(result.stderr).not.toContain('✗');
  }, 20_000);

  test('signed in with no project bound, it prints the banner and does not hang', async () => {
    const apiBase = startDetailServer();
    const configFile = writeConfig(apiBase, false);

    const result = await runCli([], { KORTIX_CONFIG_FILE: configFile });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Where you are');
    expect(requests).toEqual([]);
  }, 20_000);

  test('the help banner still lists every command tier, unchanged', async () => {
    const result = await runCli(['--help']);

    expect(result.code).toBe(0);
    for (const tier of ['Where you are', 'The linked project', 'CLI']) {
      expect(result.stdout).toContain(`\n  ${tier}`);
    }
    for (const command of ['agi', 'sessions', 'projects', 'chat']) {
      expect(result.stdout).toContain(command);
    }
  }, 20_000);

  test('an unknown command still errors instead of opening a picker', async () => {
    const result = await runCli(['definitely-not-a-command']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command');
    expect(result.stdout).not.toContain('pick an agent');
  }, 20_000);
});
