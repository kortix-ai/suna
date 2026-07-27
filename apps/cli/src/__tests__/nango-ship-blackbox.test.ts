import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = resolve(import.meta.dir, '..', 'index.ts');
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const CONNECT_LINK = 'https://connect.example.test/session_test';
const ENV_KEYS = [
  'KORTIX_API_URL',
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_PROJECT_ID',
  'KORTIX_TOKEN',
  'BASH_ENV',
] as const;

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

let root: string | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kortix Test',
      GIT_AUTHOR_EMAIL: 'test@kortix.local',
      GIT_COMMITTER_NAME: 'Kortix Test',
      GIT_COMMITTER_EMAIL: 'test@kortix.local',
    },
  }).trim();
}

function writeConfig(path: string, apiBase: string): string {
  const config = `${JSON.stringify(
    {
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'kortix_pat_blackbox',
          user_id: 'user_test',
          user_email: 'test@kortix.local',
          account_id: ACCOUNT_ID,
          logged_in_at: '2026-07-27T00:00:00.000Z',
        },
      },
    },
    null,
    2,
  )}\n`;
  writeFileSync(path, config, 'utf8');
  return config;
}

async function runCli(cwd: string, configFile: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: configFile,
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ENV_KEYS) delete env[key];

  const processResult = Bun.spawn({
    cmd: [
      process.execPath,
      CLI_ENTRY,
      'ship',
      '--yes',
      '--name',
      'Nango black-box',
      '--no-verify',
      '--no-env',
      '--no-connect',
    ],
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => processResult.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

afterEach(() => {
  server?.stop(true);
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('kortix ship Nango consent handoff', () => {
  test('non-interactive ship creates one Connect session and leaves Git unchanged', async () => {
    const requests: RecordedRequest[] = [];
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const text = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get('authorization'),
          body: text ? JSON.parse(text) : null,
        });

        if (request.method === 'GET' && url.pathname === '/v1/accounts/me') {
          return Response.json({
            accounts: [
              {
                account_id: ACCOUNT_ID,
                slug: 'test',
                name: 'Test',
                role: 'owner',
              },
            ],
          });
        }
        if (request.method === 'POST' && url.pathname === '/v1/projects/link-repository') {
          return Response.json(
            {
              error: 'A GitHub connection is required.',
              code: 'github_connection_required',
              account_id: ACCOUNT_ID,
              requires_human_oauth: true,
              sdk_action: 'createGitHubConnectSession',
            },
            { status: 409 },
          );
        }
        if (request.method === 'POST' && url.pathname === '/v1/projects/github/connect-session') {
          return Response.json({
            token: 'connect-session-token',
            expires_at: '2026-07-27T21:00:00.000Z',
            connect_link: CONNECT_LINK,
          });
        }
        return Response.json({ error: 'Unexpected route' }, { status: 500 });
      },
    });

    root = mkdtempSync(join(tmpdir(), 'kortix-nango-ship-'));
    const repo = join(root, 'repo');
    execFileSync('mkdir', ['-p', repo]);
    writeFileSync(join(repo, 'kortix.yaml'), 'name: Nango black-box\n', 'utf8');
    git(repo, ['init', '-b', 'main']);
    git(repo, ['add', 'kortix.yaml']);
    git(repo, ['commit', '-m', 'Initial commit']);
    git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git']);

    const configFile = join(root, 'config.json');
    const initialConfig = writeConfig(configFile, `http://127.0.0.1:${server.port}`);
    const initialHead = git(repo, ['rev-parse', 'HEAD']);
    const initialStatus = git(repo, ['status', '--porcelain=v1']);
    const initialGitConfig = git(repo, ['config', '--local', '--list']);

    const result = await runCli(repo, configFile);

    expect(result.code).toBe(1);
    const jsonLines = result.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'));
    expect(jsonLines).toHaveLength(1);
    const error = JSON.parse(jsonLines[0] as string) as Record<string, unknown>;
    expect(error).toEqual({
      error: 'github_connection_required',
      requires_human_oauth: true,
      account_id: ACCOUNT_ID,
      connect_link: CONNECT_LINK,
      action: 'Open connect_link in a browser, authorize GitHub, then retry the command.',
    });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/accounts/me',
      'POST /v1/projects/link-repository',
      'POST /v1/projects/github/connect-session',
    ]);
    expect(
      requests.every((request) => request.authorization === 'Bearer kortix_pat_blackbox'),
    ).toBe(true);
    expect(requests[1]?.body).toEqual({
      repo_url: 'https://github.com/acme/demo.git',
      name: 'Nango black-box',
      account_id: ACCOUNT_ID,
    });
    expect(requests[2]?.body).toEqual({ account_id: ACCOUNT_ID });

    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(initialHead);
    expect(git(repo, ['status', '--porcelain=v1'])).toBe(initialStatus);
    expect(git(repo, ['config', '--local', '--list'])).toBe(initialGitConfig);
    expect(readFileSync(configFile, 'utf8')).toBe(initialConfig);
    expect(existsSync(join(repo, '.kortix', 'link.json'))).toBe(false);

    const observable = `${result.stdout}\n${result.stderr}\n${readFileSync(configFile, 'utf8')}`;
    expect(observable).not.toContain('connect-session-token');
    expect(observable).not.toContain('push_token');
    expect(observable).not.toContain('github_token');
    expect(requests.some((request) => request.path.endsWith('/git-token'))).toBe(false);
  });
});
