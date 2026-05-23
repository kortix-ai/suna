import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSessions } from '../commands/sessions';

const PROJECT_ID = '00000000-0000-4000-a000-000000000111';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000222';

let root = '';
let repo = '';
let origin = '';
let originalCwd = '';
let previousConfigFile: string | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let sessionCreateBody: Record<string, unknown> | null = null;

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

describe('sessions new CLI flow', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kortix-cli-session-e2e-'));
    repo = join(root, 'repo');
    origin = join(root, 'origin.git');
    originalCwd = process.cwd();
    previousConfigFile = process.env.KORTIX_CONFIG_FILE;
    sessionCreateBody = null;

    mkdirSync(repo, { recursive: true });
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 'e2e@kortix.test'], repo);
    git(['config', 'user.name', 'Kortix E2E'], repo);
    writeFileSync(join(repo, 'README.md'), '# test repo\n', 'utf8');
    git(['add', 'README.md'], repo);
    git(['commit', '-m', 'initial'], repo);
    git(['-c', 'init.defaultBranch=main', 'init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin], repo);
    git(['push', '--quiet', 'origin', 'main'], repo);

    mkdirSync(join(repo, '.kortix'), { recursive: true });
    writeFileSync(
      join(repo, '.kortix', 'link.json'),
      JSON.stringify({
        project_id: PROJECT_ID,
        account_id: ACCOUNT_ID,
        host: 'default',
        host_url: 'http://127.0.0.1',
        linked_at: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === `/v1/projects/${PROJECT_ID}`) {
          return Response.json({
            project_id: PROJECT_ID,
            account_id: ACCOUNT_ID,
            name: 'test',
            repo_url: origin,
            default_branch: 'main',
            manifest_path: 'kortix.toml',
            status: 'active',
            metadata: {},
            last_opened_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          });
        }
        if (req.method === 'POST' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions`) {
          sessionCreateBody = await req.json() as Record<string, unknown>;
          const sessionId = sessionCreateBody.session_id as string;
          return Response.json({
            session_id: sessionId,
            account_id: ACCOUNT_ID,
            project_id: PROJECT_ID,
            branch_name: sessionId,
            base_ref: sessionCreateBody.base_ref,
            sandbox_provider: 'daytona',
            sandbox_id: `sandbox-${sessionId}`,
            sandbox_url: null,
            opencode_session_id: null,
            name: null,
            agent_name: 'default',
            status: 'provisioning',
            error: null,
            metadata: {},
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const configPath = join(root, 'config.json');
    process.env.KORTIX_CONFIG_FILE = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        active: 'default',
        hosts: {
          default: {
            url: `http://127.0.0.1:${server.port}`,
            token: 'test-token',
            user_id: 'user-1',
            user_email: 'user@example.test',
            account_id: ACCOUNT_ID,
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (previousConfigFile === undefined) delete process.env.KORTIX_CONFIG_FILE;
    else process.env.KORTIX_CONFIG_FILE = previousConfigFile;
    server?.stop(true);
    server = null;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('creates the session branch with local git credentials before creating the API session', async () => {
    const code = await runSessions(['new']);

    expect(code).toBe(0);
    expect(sessionCreateBody).not.toBeNull();
    const sessionId = sessionCreateBody!.session_id as string;
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionCreateBody).toMatchObject({
      branch_already_created: true,
      base_ref: 'main',
    });

    const baseSha = git(['--git-dir', origin, 'rev-parse', 'refs/heads/main']);
    const sessionSha = git(['--git-dir', origin, 'rev-parse', `refs/heads/${sessionId}`]);
    expect(sessionSha).toBe(baseSha);
  });
});
