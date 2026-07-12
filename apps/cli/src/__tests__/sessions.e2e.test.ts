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
let previousCliToken: string | undefined;
let previousExecutorToken: string | undefined;
let previousApiUrl: string | undefined;
let previousProjectId: string | undefined;
let previousServiceToken: string | undefined;
let previousBashEnv: string | undefined;
let previousDisableSandboxEnvFile: string | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let sessionCreateBody: Record<string, unknown> | null = null;
let sessionList: Record<string, unknown>[] = [];
let transcriptRequests: URL[] = [];

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
    previousCliToken = process.env.KORTIX_CLI_TOKEN;
    previousExecutorToken = process.env.KORTIX_EXECUTOR_TOKEN;
    previousApiUrl = process.env.KORTIX_API_URL;
    previousProjectId = process.env.KORTIX_PROJECT_ID;
    previousServiceToken = process.env.KORTIX_TOKEN;
    previousBashEnv = process.env.BASH_ENV;
    previousDisableSandboxEnvFile = process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE;
    delete process.env.KORTIX_CLI_TOKEN;
    delete process.env.KORTIX_EXECUTOR_TOKEN;
    delete process.env.KORTIX_API_URL;
    delete process.env.KORTIX_PROJECT_ID;
    delete process.env.KORTIX_TOKEN;
    delete process.env.BASH_ENV;
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    sessionCreateBody = null;
    sessionList = [];
    transcriptRequests = [];

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
            manifest_path: 'kortix.yaml',
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
        if (req.method === 'GET' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions`) {
          return Response.json(sessionList);
        }
        const transcriptMatch = url.pathname.match(new RegExp(`^/v1/projects/${PROJECT_ID}/sessions/([^/]+)/transcript$`));
        if (req.method === 'GET' && transcriptMatch) {
          transcriptRequests.push(url);
          return Response.json({
            available: true,
            reason: null,
            opencode_session_id: 'ses_test',
            message_count: 2,
            messages: [
              {
                role: 'user',
                created: '2026-06-20T00:00:00.000Z',
                completed: null,
                text: 'Review recent sessions',
                tools: [],
                files: [],
                reasoning_omitted: false,
                error: null,
              },
              {
                role: 'assistant',
                created: '2026-06-20T00:01:00.000Z',
                completed: '2026-06-20T00:02:00.000Z',
                text: 'Found the important changes.',
                tools: [{ tool: 'bash', status: 'completed', output: 'must not leak' }],
                files: [],
                reasoning_omitted: true,
                error: null,
                output: 'must not leak',
              },
            ],
          });
        }
        return Response.json({ error: `not found ${url.pathname}` }, { status: 404 });
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
    if (previousCliToken === undefined) delete process.env.KORTIX_CLI_TOKEN;
    else process.env.KORTIX_CLI_TOKEN = previousCliToken;
    if (previousExecutorToken === undefined) delete process.env.KORTIX_EXECUTOR_TOKEN;
    else process.env.KORTIX_EXECUTOR_TOKEN = previousExecutorToken;
    if (previousApiUrl === undefined) delete process.env.KORTIX_API_URL;
    else process.env.KORTIX_API_URL = previousApiUrl;
    if (previousProjectId === undefined) delete process.env.KORTIX_PROJECT_ID;
    else process.env.KORTIX_PROJECT_ID = previousProjectId;
    if (previousServiceToken === undefined) delete process.env.KORTIX_TOKEN;
    else process.env.KORTIX_TOKEN = previousServiceToken;
    if (previousBashEnv === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = previousBashEnv;
    if (previousDisableSandboxEnvFile === undefined) delete process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE;
    else process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = previousDisableSandboxEnvFile;
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

  test('digest uses compact project transcript endpoint', async () => {
    const runningId = '11111111-1111-4111-8111-111111111111';
    const stoppedId = '22222222-2222-4222-8222-222222222222';
    sessionList = [
      {
        session_id: runningId,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        branch_name: runningId,
        base_ref: 'main',
        sandbox_provider: 'daytona',
        sandbox_id: runningId,
        sandbox_url: `http://127.0.0.1/v1/p/external-${runningId}/8000`,
        runtime_session_id: 'ses_test',
        runtime_protocol: 'acp',
        name: 'Digest target',
        agent_name: 'memory-reflector',
        status: 'running',
        error: null,
        metadata: {},
        runtime_sessions: [
          {
            id: 'ses_test',
            title: 'Digest target',
            parent_id: null,
            project_id: null,
            created_at: 0,
            updated_at: 0,
            archived_at: null,
          },
        ],
        created_at: '2026-06-20T00:00:00.000Z',
        updated_at: '2026-06-20T00:05:00.000Z',
      },
      {
        session_id: stoppedId,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        branch_name: stoppedId,
        base_ref: 'main',
        sandbox_provider: 'daytona',
        sandbox_id: stoppedId,
        sandbox_url: null,
        runtime_session_id: null,
        runtime_protocol: 'acp',
        name: 'Stopped target',
        agent_name: 'default',
        status: 'stopped',
        error: null,
        metadata: {},
        runtime_sessions: [],
        created_at: '2026-06-20T00:00:00.000Z',
        updated_at: '2026-06-20T00:03:00.000Z',
      },
    ];

    const { code, stdout } = await captureStdout(() =>
      runSessions(['digest', '--all', '--messages', '5', '--chars', '120', '--json']),
    );

    expect(code).toBe(0);
    expect(transcriptRequests).toHaveLength(1);
    expect(transcriptRequests[0]!.searchParams.get('limit')).toBe('5');
    expect(transcriptRequests[0]!.searchParams.get('chars')).toBe('120');

    const parsed = JSON.parse(stdout) as {
      sessions: Array<{
        session: { runtime_titles: string[] };
        transcript: { available: boolean; messages: Array<{ tools: unknown[] }> };
      }>;
    };
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0]!.session.runtime_titles).toEqual(['Digest target']);
    expect(parsed.sessions[0]!.transcript.available).toBe(true);
    expect(parsed.sessions[1]!.transcript.available).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('must not leak');
    expect(parsed.sessions[0]!.transcript.messages[1]!.tools).toEqual([
      { tool: 'bash', status: 'completed' },
    ]);
  });
});

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const originalWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}
