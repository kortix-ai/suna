import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitManifest } from '../lib/triggers';
import { readManifest } from '../triggers';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from './branches';
import type { GitBackedWorkspace } from './types';

const exec = promisify(execFile);

let testRoot = '';
let remotePath = '';
let seedPath = '';
let project: GitBackedWorkspace;

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await exec('git', args, { cwd });
  return result.stdout.trim();
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-manifest-cas-'));
  remotePath = join(testRoot, 'remote.git');
  seedPath = join(testRoot, 'seed');
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', seedPath]);
  await git(['config', 'user.name', 'Kortix Test'], seedPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], seedPath);
  await writeFile(join(seedPath, 'kortix.yaml'), 'kortix_version: 2\nconnectors: []\n');
  await git(['add', 'kortix.yaml'], seedPath);
  await git(['commit', '-m', 'seed manifest'], seedPath);
  await git(['remote', 'add', 'origin', remotePath], seedPath);
  await git(['push', 'origin', 'main'], seedPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    workspaceId: `manifest-cas-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('manifest file compare-and-swap', () => {
  test('rejects a stale manifest revision without overwriting the winning write', async () => {
    const original = await readManifest(project);
    expect(original?.revision).toMatch(/^[0-9a-f]{40}$/);
    if (!original) throw new Error('Expected the seeded manifest');

    const first = structuredClone(original);
    first.raw.connectors = [{ slug: 'first', provider: 'http' }];
    const stale = structuredClone(original);
    stale.raw.connectors = [{ slug: 'stale', provider: 'http' }];

    expect(
      await commitManifest(project as Parameters<typeof commitManifest>[0], first, 'first write'),
    ).toEqual({ ok: true });

    expect(
      await commitManifest(project as Parameters<typeof commitManifest>[0], stale, 'stale write'),
    ).toEqual({
      error: 'File "kortix.yaml" changed since it was read',
      status: 409,
    });

    expect(await git(['--git-dir', remotePath, 'show', 'main:kortix.yaml'])).toContain(
      'slug: first',
    );
  });

  test('protects a multi-file manifest update with the observed revision', async () => {
    const original = await readManifest(project);
    expect(original?.revision).toMatch(/^[0-9a-f]{40}$/);
    if (!original?.revision) throw new Error('Expected the seeded manifest revision');

    await commitMultipleFilesToBranch(project, {
      files: [
        {
          path: 'kortix.yaml',
          content: 'kortix_version: 2\nconnectors:\n  - slug: first\n    provider: http\n',
        },
        { path: '.kortix/opencode/agents/default.md', content: 'first behavior\n' },
      ],
      message: 'first multi-file write',
      expectedFileRevision: {
        path: 'kortix.yaml',
        sha: original.revision,
        candidatePaths: original.candidatePaths,
      },
    });

    await expect(
      commitMultipleFilesToBranch(project, {
        files: [
          {
            path: 'kortix.yaml',
            content: 'kortix_version: 2\nconnectors:\n  - slug: stale\n    provider: http\n',
          },
          { path: '.kortix/opencode/agents/default.md', content: 'stale behavior\n' },
        ],
        message: 'stale multi-file write',
        expectedFileRevision: {
          path: 'kortix.yaml',
          sha: original.revision,
          candidatePaths: original.candidatePaths,
        },
      }),
    ).rejects.toBeInstanceOf(GitFileRevisionConflictError);

    expect(await git(['--git-dir', remotePath, 'show', 'main:kortix.yaml'])).toContain(
      'slug: first',
    );
    expect(
      await git(['--git-dir', remotePath, 'show', 'main:.kortix/opencode/agents/default.md']),
    ).toBe('first behavior');
  });

  test('rejects a write when a higher-priority manifest appears', async () => {
    await git(['rm', 'kortix.yaml'], seedPath);
    await writeFile(
      join(seedPath, 'kortix.toml'),
      'kortix_version = 1\n[project]\nname = "initial"\n',
    );
    await git(['add', 'kortix.toml'], seedPath);
    await git(['commit', '-m', 'switch to toml'], seedPath);
    await git(['push', 'origin', 'main'], seedPath);

    const original = await readManifest(project);
    expect(original?.path).toBe('kortix.toml');
    expect(original?.candidatePaths).toEqual(['kortix.yaml', 'kortix.yml', 'kortix.toml']);
    if (!original) throw new Error('Expected the TOML manifest');

    await writeFile(
      join(seedPath, 'kortix.yaml'),
      'kortix_version: 2\nproject:\n  name: concurrent\nconnectors: []\n',
    );
    await git(['add', 'kortix.yaml'], seedPath);
    await git(['commit', '-m', 'add higher priority manifest'], seedPath);
    await git(['push', 'origin', 'main'], seedPath);

    const stale = structuredClone(original);
    stale.raw.project = { name: 'stale' };
    expect(
      await commitManifest(project as Parameters<typeof commitManifest>[0], stale, 'stale write'),
    ).toEqual({
      error: 'File "kortix.toml" changed since it was read',
      status: 409,
    });

    expect(await git(['--git-dir', remotePath, 'show', 'main:kortix.yaml'])).toContain(
      'name: concurrent',
    );
    expect(await git(['--git-dir', remotePath, 'show', 'main:kortix.toml'])).toContain(
      'name = "initial"',
    );
  });

  test('restores the losing mirror after a concurrent push race', async () => {
    const hookPath = join(remotePath, 'hooks', 'pre-receive');
    await writeFile(hookPath, '#!/bin/sh\nsleep 0.25\n');
    await chmod(hookPath, 0o755);

    const firstWorkspace = { ...project, workspaceId: `${project.workspaceId}-first` };
    const secondWorkspace = { ...project, workspaceId: `${project.workspaceId}-second` };
    const firstObserved = await readManifest(firstWorkspace);
    const secondObserved = await readManifest(secondWorkspace);
    if (!firstObserved || !secondObserved) throw new Error('Expected both manifest reads');

    const first = structuredClone(firstObserved);
    first.raw.connectors = [{ slug: 'first', provider: 'http' }];
    const second = structuredClone(secondObserved);
    second.raw.connectors = [{ slug: 'second', provider: 'http' }];

    const results = await Promise.all([
      commitManifest(
        firstWorkspace as Parameters<typeof commitManifest>[0],
        first,
        'concurrent first write',
      ),
      commitManifest(
        secondWorkspace as Parameters<typeof commitManifest>[0],
        second,
        'concurrent second write',
      ),
    ]);

    expect(results.filter((result) => 'ok' in result)).toHaveLength(1);
    expect(results.filter((result) => 'status' in result && result.status === 409)).toHaveLength(1);

    const remoteManifest = await git(['--git-dir', remotePath, 'show', 'main:kortix.yaml']);
    const winner = remoteManifest.includes('slug: first') ? 'first' : 'second';
    const losingWorkspace = results[0] && 'status' in results[0] ? firstWorkspace : secondWorkspace;
    const warmRead = await readManifest(losingWorkspace);
    expect(warmRead?.raw.connectors).toEqual([{ slug: winner, provider: 'http' }]);
  });

  test('never exposes an unaccepted commit through the shared mirror', async () => {
    const pushStarted = join(testRoot, 'push-started');
    const pushRelease = join(testRoot, 'push-release');
    const hookPath = join(remotePath, 'hooks', 'pre-receive');
    await writeFile(
      hookPath,
      `#!/bin/sh\ntouch "${pushStarted}"\nwhile [ ! -f "${pushRelease}" ]; do sleep 0.01; done\nexit 1\n`,
    );
    await chmod(hookPath, 0o755);

    const original = await readManifest(project);
    if (!original) throw new Error('Expected the seeded manifest');
    const rejected = structuredClone(original);
    rejected.raw.connectors = [{ slug: 'never-landed', provider: 'http' }];

    const commit = commitManifest(
      project as Parameters<typeof commitManifest>[0],
      rejected,
      'rejected write',
    );
    let visibleDuringPush: Awaited<ReturnType<typeof readManifest>> = null;
    try {
      await waitForFile(pushStarted);
      visibleDuringPush = await readManifest(project);
    } finally {
      await writeFile(pushRelease, 'release\n');
    }

    expect(visibleDuringPush?.raw.connectors).toEqual([]);
    expect(await commit).toMatchObject({ status: 502 });
    expect(await git(['--git-dir', remotePath, 'show', 'main:kortix.yaml'])).not.toContain(
      'never-landed',
    );
    expect((await readManifest(project))?.raw.connectors).toEqual([]);
  });
});
