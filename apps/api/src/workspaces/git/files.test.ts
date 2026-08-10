import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOperationError, isGitPathNotFoundError, runGit as realRunGit } from './mirror';
import { isRepoFileNotFoundError, RepoFileNotFoundError } from './files';

// `readRepoFile` imports `runGit` + `refreshMirror` from `./mirror`. We mock the
// module so `runGit` is controllable per-test (returns stdout, throws a
// path-not-found GitOperationError, or throws a real git failure) and
// `refreshMirror` short-circuits to a temp dir without touching the network.
const mirrorModule = await import('./mirror');

let runGitImpl: (...args: Parameters<typeof realRunGit>) => Promise<{ stdout: string; stderr: string }>;
let repoPath = '';

mock.module('./mirror', () => ({
  ...mirrorModule,
  runGit: async (...args: Parameters<typeof realRunGit>) => runGitImpl(...args),
  refreshMirror: async () => repoPath,
}));

const { readRepoFile } = await import('./files');

const project = {
  workspaceId: 'test-project',
  defaultBranch: 'main',
  repoUrl: 'https://github.com/kortix-ai/test.git',
  gitAuthToken: null,
  gitAuthHeaders: {},
} as any;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'kortix-readrepofile-test-'));
  runGitImpl = realRunGit;
});

afterEach(async () => {
  if (repoPath) await rm(repoPath, { recursive: true, force: true });
});

describe('isGitPathNotFoundError', () => {
  test('returns true for the EXACT prod message (Windows path, quoted)', () => {
    const err = new GitOperationError({
      kind: 'failed',
      message: `Command failed: git show main:"C:\\Users\\bibon\\Desktop\\Fortnite.url"\nfatal: path '"C:\\Users\\bibon\\Desktop\\Fortnite.url"' does not exist in 'main'`,
      gitArgs: ['show', 'main:"C:\\Users\\bibon\\Desktop\\Fortnite.url"'],
      stderr: `fatal: path '"C:\\Users\\bibon\\Desktop\\Fortnite.url"' does not exist in 'main'`,
      exitCode: 128,
    });
    expect(isGitPathNotFoundError(err)).toBe(true);
  });

  test('returns true for a plain missing-path git message', () => {
    const err = new GitOperationError({
      kind: 'failed',
      message: `fatal: path 'postcss.config.js' does not exist in 'my-change'`,
      gitArgs: ['show', 'my-change:postcss.config.js'],
      stderr: `fatal: path 'postcss.config.js' does not exist in 'my-change'`,
      exitCode: 128,
    });
    expect(isGitPathNotFoundError(err)).toBe(true);
  });

  test('returns true when the wording is only in the message (stderr empty)', () => {
    const err = new GitOperationError({
      kind: 'failed',
      message: `fatal: path 'openapi.yaml' does not exist in 'main'`,
      gitArgs: ['show', 'main:openapi.yaml'],
      stderr: '',
      exitCode: 128,
    });
    expect(isGitPathNotFoundError(err)).toBe(true);
  });

  test('returns false for a real git failure (not a git repository)', () => {
    const err = new GitOperationError({
      kind: 'failed',
      message: `fatal: not a git repository (or any of the parent directories): .git`,
      gitArgs: ['show', 'main:file.txt'],
      stderr: `fatal: not a git repository (or any of the parent directories): .git`,
      exitCode: 128,
    });
    expect(isGitPathNotFoundError(err)).toBe(false);
  });

  test('returns false for an auth failure', () => {
    const err = new GitOperationError({
      kind: 'failed',
      message: `fatal: could not read Username for 'https://github.com': No such device or address`,
      gitArgs: ['fetch', 'origin'],
      stderr: `fatal: could not read Username for 'https://github.com': No such device or address`,
      exitCode: 128,
    });
    expect(isGitPathNotFoundError(err)).toBe(false);
  });

  test('returns false for a timeout (transient, must still page)', () => {
    const err = new GitOperationError({
      kind: 'timeout',
      message: `git show timed out after 30000ms (signal SIGTERM)`,
      gitArgs: ['show', 'main:openapi.yaml'],
      signal: 'SIGTERM',
      stderr: '',
    });
    expect(isGitPathNotFoundError(err)).toBe(false);
  });

  test('returns false for a non-GitOperationError', () => {
    expect(isGitPathNotFoundError(new Error('does not exist in main'))).toBe(false);
    expect(isGitPathNotFoundError(null)).toBe(false);
    expect(isGitPathNotFoundError(undefined)).toBe(false);
  });
});

describe('readRepoFile', () => {
  test('throws a RepoFileNotFoundError for a path that does not exist in the repo (the prod failure shape)', async () => {
    runGitImpl = async () => {
      throw new GitOperationError({
        kind: 'failed',
        message: `Command failed: git show main:"C:\\Users\\bibon\\Desktop\\Fortnite.url"\nfatal: path '"C:\\Users\\bibon\\Desktop\\Fortnite.url"' does not exist in 'main'`,
        gitArgs: ['show', 'main:"C:\\Users\\bibon\\Desktop\\Fortnite.url"'],
        stderr: `fatal: path '"C:\\Users\\bibon\\Desktop\\Fortnite.url"' does not exist in 'main'`,
        exitCode: 128,
      });
    };
    const promise = readRepoFile(project, 'C:\\Users\\bibon\\Desktop\\Fortnite.url', 'main');
    await expect(promise).rejects.toBeInstanceOf(RepoFileNotFoundError);
    await expect(promise).rejects.toMatchObject({
      name: 'RepoFileNotFoundError',
      filePath: 'C:\\Users\\bibon\\Desktop\\Fortnite.url',
      ref: 'main',
    });
    // And the typed guard recognizes it.
    try {
      await readRepoFile(project, 'C:\\Users\\bibon\\Desktop\\Fortnite.url', 'main');
    } catch (err) {
      expect(isRepoFileNotFoundError(err)).toBe(true);
    }
  });

  test('throws a RepoFileNotFoundError for a plain missing path', async () => {
    runGitImpl = async () => {
      throw new GitOperationError({
        kind: 'failed',
        message: `fatal: path 'openapi.yaml' does not exist in 'main'`,
        gitArgs: ['show', 'main:openapi.yaml'],
        stderr: `fatal: path 'openapi.yaml' does not exist in 'main'`,
        exitCode: 128,
      });
    };
    await expect(readRepoFile(project, 'openapi.yaml', 'main')).rejects.toBeInstanceOf(RepoFileNotFoundError);
  });

  test('still throws the original GitOperationError for a real git failure (genuine bugs propagate)', async () => {
    const realErr = new GitOperationError({
      kind: 'failed',
      message: `fatal: not a git repository (or any of the parent directories): .git`,
      gitArgs: ['show', 'main:file.txt'],
      stderr: `fatal: not a git repository (or any of the parent directories): .git`,
      exitCode: 128,
    });
    runGitImpl = async () => {
      throw realErr;
    };
    await expect(readRepoFile(project, 'file.txt', 'main')).rejects.toBe(realErr);
    // And the typed guard does NOT misclassify a genuine git failure.
    try {
      await readRepoFile(project, 'file.txt', 'main');
    } catch (err) {
      expect(isRepoFileNotFoundError(err)).toBe(false);
    }
  });

  test('still throws for a timeout (transient failures must page)', async () => {
    const timeoutErr = new GitOperationError({
      kind: 'timeout',
      message: `git show timed out after 30000ms (signal SIGTERM)`,
      gitArgs: ['show', 'main:openapi.yaml'],
      signal: 'SIGTERM',
      stderr: '',
    });
    runGitImpl = async () => {
      throw timeoutErr;
    };
    await expect(readRepoFile(project, 'openapi.yaml', 'main')).rejects.toBe(timeoutErr);
  });

  test('returns the content for a valid path (happy path, unchanged)', async () => {
    runGitImpl = async () => ({ stdout: 'openapi: 3.0.0\n', stderr: '' });
    const content = await readRepoFile(project, 'openapi.yaml', 'main');
    expect(content).toBe('openapi: 3.0.0\n');
  });

  test('throws "File path is required" for an empty/normalized-null path', async () => {
    await expect(readRepoFile(project, '', 'main')).rejects.toThrow('File path is required');
    await expect(readRepoFile(project, '/', 'main')).rejects.toThrow('File path is required');
  });

  test('throws "Invalid path" for a path traversal attempt', async () => {
    await expect(readRepoFile(project, '../etc/passwd', 'main')).rejects.toThrow('Invalid path');
  });

  test('uses the default branch when no ref is given', async () => {
    let capturedArgs: readonly string[] = [];
    runGitImpl = async (args) => {
      capturedArgs = args;
      return { stdout: 'content', stderr: '' };
    };
    await readRepoFile(project, 'file.txt');
    expect(capturedArgs).toEqual(['show', 'main:file.txt']);
  });
});

describe('RepoFileNotFoundError', () => {
  test('is a typed Error with filePath/ref + a cause', () => {
    const cause = new Error('underlying');
    const err = new RepoFileNotFoundError('openapi.yaml', 'main', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RepoFileNotFoundError');
    expect(err.filePath).toBe('openapi.yaml');
    expect(err.ref).toBe('main');
    expect(err.message).toBe(`file not found in repository at 'main:openapi.yaml'`);
    expect((err as any).cause).toBe(cause);
  });

  test('isRepoFileNotFoundError narrows the type', () => {
    const err = new RepoFileNotFoundError('x', 'main');
    expect(isRepoFileNotFoundError(err)).toBe(true);
    expect(isRepoFileNotFoundError(new Error('x'))).toBe(false);
    expect(isRepoFileNotFoundError(null)).toBe(false);
    expect(isRepoFileNotFoundError(undefined)).toBe(false);
  });
});
