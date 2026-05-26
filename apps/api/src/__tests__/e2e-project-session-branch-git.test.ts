import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let root = '';
let previousCacheDir: string | undefined;
let previousBranchWorkDir: string | undefined;

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function bunEval(script: string): string {
  return execFileSync('bun', ['--eval', script], {
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function gitTransportModuleUrl(): string {
  return pathToFileURL(join(import.meta.dir, '..', 'projects', 'git.ts')).href;
}

describe('session branch git transport', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kortix-session-branch-e2e-'));
    previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
    previousBranchWorkDir = process.env.KORTIX_GIT_BRANCH_WORK_DIR;
    process.env.KORTIX_GIT_CACHE_DIR = join(root, 'git-cache');
    process.env.KORTIX_GIT_BRANCH_WORK_DIR = join(root, 'branch-work');
  });

  afterEach(async () => {
    if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
    else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    if (previousBranchWorkDir === undefined) delete process.env.KORTIX_GIT_BRANCH_WORK_DIR;
    else process.env.KORTIX_GIT_BRANCH_WORK_DIR = previousBranchWorkDir;
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('creates GitHub session branches through the refs API without git fetch', async () => {
    const baseSha = 'a'.repeat(40);

    const result = JSON.parse(bunEval(`
      const { existsSync } = await import('node:fs');
      const requests = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url, method, body });
        if (method === 'GET' && url.endsWith('/repos/kortix-ai/suna/git/ref/heads%2Fmain')) {
          return new Response(JSON.stringify({ object: { sha: '${baseSha}', type: 'commit' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (method === 'POST' && url.endsWith('/repos/kortix-ai/suna/git/refs')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ message: 'unexpected request' }), { status: 500 });
      };
      const { createRemoteSessionBranch } = await import(${JSON.stringify(gitTransportModuleUrl())});
      await createRemoteSessionBranch(
        {
          projectId: '00000000-0000-4000-a000-000000000998',
          repoUrl: 'https://github.com/kortix-ai/suna.git',
          defaultBranch: 'main',
          manifestPath: 'kortix.toml',
          gitAuthToken: 'github-token',
        },
        'session-branch-002',
        'main',
      );
      process.stdout.write(JSON.stringify({
        methods: requests.map((request) => request.method),
        body: requests[1]?.body ?? null,
        branchWorkExists: existsSync(process.env.KORTIX_GIT_BRANCH_WORK_DIR),
        cacheExists: existsSync(process.env.KORTIX_GIT_CACHE_DIR),
      }));
    `));

    expect(result.methods).toEqual(['GET', 'POST']);
    expect(result.body).toEqual({
      ref: 'refs/heads/session-branch-002',
      sha: baseSha,
    });
    expect(result.branchWorkExists).toBe(false);
    expect(result.cacheExists).toBe(false);
  });

  test('creates the remote session branch without materializing a full mirror cache', async () => {
    const source = join(root, 'source');
    const origin = join(root, 'origin.git');
    mkdirSync(source, { recursive: true });

    git(['init', '-b', 'main'], source);
    git(['config', 'user.email', 'e2e@kortix.test'], source);
    git(['config', 'user.name', 'Kortix E2E'], source);
    writeFileSync(join(source, 'README.md'), '# test repo\n', 'utf8');
    git(['add', 'README.md'], source);
    git(['commit', '-m', 'initial'], source);

    git(['-c', 'init.defaultBranch=main', 'init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin], source);
    git(['push', '--quiet', 'origin', 'main'], source);

    bunEval(`
      const { createRemoteSessionBranch } = await import(${JSON.stringify(gitTransportModuleUrl())});
      await createRemoteSessionBranch(
        {
          projectId: '00000000-0000-4000-a000-000000000999',
          repoUrl: ${JSON.stringify(origin)},
          defaultBranch: 'main',
          manifestPath: 'kortix.toml',
        },
        'session-branch-001',
        'main',
      );
    `);

    const baseSha = git(['--git-dir', origin, 'rev-parse', 'refs/heads/main']);
    const sessionSha = git(['--git-dir', origin, 'rev-parse', 'refs/heads/session-branch-001']);
    expect(sessionSha).toBe(baseSha);

    const cacheDir = process.env.KORTIX_GIT_CACHE_DIR!;
    const cacheEntries = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
    expect(cacheEntries).toEqual([]);
  });
});
