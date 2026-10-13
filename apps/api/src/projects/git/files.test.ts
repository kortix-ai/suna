import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GitOperationError, isGitPathNotFoundError, runGit as realRunGit } from './mirror';
import {
  decodeDirectoryCursor,
  encodeDirectoryCursor,
  isRepoFileNotFoundError,
  listRepoDirectory,
  readRepoFileBytes,
  RepoFileNotFoundError,
} from './files';

// `readRepoFile` imports `runGit` + `refreshMirror` from `./mirror`. We mock the
// module so `runGit` is controllable per-test (returns stdout, throws a
// path-not-found GitOperationError, or throws a real git failure) and
// `refreshMirror` short-circuits to a temp dir without touching the network.
const mirrorModule = await import('./mirror');
// `mock.module` below re-binds the static import of `runGit` to the mock, so
// the REAL runGit (needed by the byte-accurate readRepoFileBytes tests) must
// be captured from the pre-mock namespace object.
const realRunGitFn = mirrorModule.runGit;

type RunGitArgs = Parameters<typeof realRunGitFn>;
let runGitImpl: (...args: RunGitArgs) => Promise<{ stdout: string; stderr: string }>;
let repoPath = '';
/** The `force` argument of every `refreshMirror` call. */
let refreshes: unknown[] = [];

mock.module('./mirror', () => ({
  ...mirrorModule,
  runGit: async (...args: RunGitArgs) => runGitImpl(...args),
  refreshMirror: async (_project: unknown, force: unknown = false) => {
    refreshes.push(force);
    return repoPath;
  },
}));

const { readRepoFile } = await import('./files');

const project = {
  projectId: 'test-project',
  defaultBranch: 'main',
  repoUrl: 'https://github.com/kortix-ai/test.git',
  gitAuthToken: null,
  gitAuthHeaders: {},
} as any;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'kortix-readrepofile-test-'));
  runGitImpl = realRunGitFn;
  refreshes = [];
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

// The byte-accurate read runs REAL git against a real repository created in
// `repoPath` — the directory the mocked `refreshMirror` returns. A mocked
// runGit would only prove that the code forwards its own mock, which is
// exactly the failure this read exists to fix.
const execFileAsyncBytes = promisify(execFile);
const BYTES_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Kortix',
  GIT_AUTHOR_EMAIL: 'noreply@kortix.invalid',
  GIT_COMMITTER_NAME: 'Kortix',
  GIT_COMMITTER_EMAIL: 'noreply@kortix.invalid',
};

// Bytes that are NOT valid UTF-8 and DO contain NULs: a PNG header plus a
// 0xFF 0xFE run. `git show` captured as a UTF-8 string mangles every byte of
// this (replacement characters), which is the defect the byte read fixes.
const PNG_LIKE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0xff, 0xfe, 0xfa, 0xde,
]);

async function commitFiles(files: Record<string, Buffer | string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(repoPath, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await execFileAsyncBytes('git', ['-C', repoPath, 'add', '-A'], { env: BYTES_ENV });
  await execFileAsyncBytes('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'seed'], { env: BYTES_ENV });
}

async function initRealRepo() {
  runGitImpl = realRunGitFn;
  await execFileAsyncBytes('git', ['init', '-b', 'main', repoPath], { env: BYTES_ENV });
}

// KRTX-1723: the Files tree was built from a recursive list cut at 1,000
// files, so every folder that sorted after file 1,000 was missing.
describe('listRepoDirectory', () => {
  async function bigRepo() {
    await initRealRepo();
    const files: Record<string, string> = { 'README.md': 'hi\n', 'z/last.txt': 'last\n' };
    for (let i = 0; i < 1200; i++) files[`a/f${String(i).padStart(4, '0')}.txt`] = `${i}\n`;
    await commitFiles(files);
  }

  async function headSha() {
    const { stdout } = await execFileAsyncBytes('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { env: BYTES_ENV });
    return stdout.toString().trim();
  }

  test('lists one level of the root: every folder and file, with its type and the commit it read', async () => {
    await bigRepo();
    expect(await listRepoDirectory(project, 'main', null)).toEqual({
      entries: [
        { path: 'README.md', type: 'file', size: 3 },
        { path: 'a', type: 'directory' },
        { path: 'z', type: 'directory' },
      ],
      truncated: false,
      commit: await headSha(),
      nextKey: null,
    });
  });

  test('lists one level of a folder, complete past 1,000 entries', async () => {
    await bigRepo();
    const listing = await listRepoDirectory(project, 'main', 'a');
    expect(listing.truncated).toBe(false);
    expect(listing.entries).toHaveLength(1200);
    expect(listing.entries.at(-1)).toEqual({ path: 'a/f1199.txt', type: 'file', size: 5 });
    expect((await listRepoDirectory(project, 'main', 'z')).entries).toEqual([{ path: 'z/last.txt', type: 'file', size: 5 }]);
  });

  test('a folder over the entry cap says so, and names the key the next page starts after', async () => {
    await bigRepo();
    const listing = await listRepoDirectory(project, 'main', 'a', { limit: 500 });
    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
    expect(listing.nextKey).toBe('a/f0499.txt');
  });

  test('pages a 1,200-entry folder 500 + 500 + 200: every entry once, in order', async () => {
    await bigRepo();
    const whole = await listRepoDirectory(project, 'main', 'a');
    const pages: { entries: { path: string }[]; truncated: boolean; nextKey: string | null }[] = [];
    let after: { commit: string; key: string } | undefined;
    do {
      const page = await listRepoDirectory(project, 'main', 'a', { limit: 500, after });
      pages.push(page);
      after = page.nextKey ? { commit: page.commit!, key: page.nextKey } : undefined;
    } while (after);
    expect(pages.map((p) => p.entries.length)).toEqual([500, 500, 200]);
    expect(pages.map((p) => p.truncated)).toEqual([true, true, false]);
    expect(pages.at(-1)!.nextKey).toBeNull();
    expect(pages.flatMap((p) => p.entries)).toEqual(whole.entries);
  });

  test('a later page reads the commit the first page read: a push between pages skips or repeats nothing', async () => {
    await bigRepo();
    const first = await listRepoDirectory(project, 'main', 'a', { limit: 500 });
    // A push lands between the two pages: one entry before the key, one after, one removed.
    await execFileAsyncBytes('git', ['-C', repoPath, 'rm', '-q', 'a/f0700.txt'], { env: BYTES_ENV });
    await commitFiles({ 'a/f0100x.txt': 'x\n', 'a/f0600x.txt': 'x\n' });
    const second = await listRepoDirectory(project, 'main', 'a', {
      limit: 500,
      after: { commit: first.commit!, key: first.nextKey! },
    });
    expect(second.commit).toBe(first.commit);
    expect(second.entries.map((e) => e.path)).toEqual(
      Array.from({ length: 500 }, (_, i) => `a/f${String(500 + i).padStart(4, '0')}.txt`),
    );
  });

  test('keys compare in git byte order, a folder as "name/": paging by one walks every name once', async () => {
    await initRealRepo();
    // UTF-16 order puts '𝒜' (U+1D49C) before 'ｚ' (U+FF5A); UTF-8 byte order, which git uses, puts it after.
    await commitFiles({ B: '', 'a.txt': '', 'a/x': '', a0: '', 'é': '', 'ｚ': '', '𝒜': '' });
    const whole = await listRepoDirectory(project, 'main', null);
    expect(whole.entries.map((e) => e.path)).toEqual(['B', 'a.txt', 'a', 'a0', 'é', 'ｚ', '𝒜']);
    const walked: string[] = [];
    const keys: string[] = [];
    let after: { commit: string; key: string } | undefined;
    do {
      const page = await listRepoDirectory(project, 'main', null, { limit: 1, after });
      walked.push(...page.entries.map((e) => e.path));
      if (page.nextKey) keys.push(page.nextKey);
      after = page.nextKey ? { commit: page.commit!, key: page.nextKey } : undefined;
    } while (after);
    expect(walked).toEqual(['B', 'a.txt', 'a', 'a0', 'é', 'ｚ', '𝒜']);
    expect(keys).toEqual(['B', 'a.txt', 'a/', 'a0', 'é', 'ｚ']);
  });

  test('a name that is not UTF-8 never makes a later page skip an entry', async () => {
    await initRealRepo();
    await commitFiles({ 'README.md': 'x\n' });
    const { stdout: blob } = await execFileAsyncBytes('git', ['-C', repoPath, 'rev-parse', 'HEAD:README.md'], { env: BYTES_ENV });
    const sha = blob.toString().trim();
    // `caf\xE9.txt` is Latin-1, not UTF-8: it decodes to `caf\uFFFD.txt`, whose
    // UTF-8 bytes (EF BF BD) sort after `cafｚ.txt` (EF BC 9A). Git lists it first.
    const input = Buffer.concat([
      Buffer.from(`100644 blob ${sha}\tcaf`),
      Buffer.from([0xe9]),
      Buffer.from('.txt'),
      Buffer.from([0]),
      Buffer.from(`100644 blob ${sha}\tcafｚ.txt`),
      Buffer.from([0]),
    ]);
    const tree = spawnSync('git', ['-C', repoPath, 'mktree', '-z'], { input, env: BYTES_ENV }).stdout.toString().trim();
    const commit = spawnSync('git', ['-C', repoPath, 'commit-tree', tree, '-m', 'latin-1 name'], { env: BYTES_ENV })
      .stdout.toString()
      .trim();
    spawnSync('git', ['-C', repoPath, 'update-ref', 'refs/heads/main', commit], { env: BYTES_ENV });

    const walked: string[] = [];
    let after: { commit: string; key: string } | undefined;
    do {
      const page = await listRepoDirectory(project, 'main', null, { limit: 1, after });
      walked.push(...page.entries.map((e) => e.path));
      after = page.nextKey ? { commit: page.commit!, key: page.nextKey } : undefined;
    } while (after && walked.length < 5);
    expect(walked).toEqual(['caf\uFFFD.txt', 'cafｚ.txt']);
  });

  test('the visibility filter runs before the cut: a page stays full and never ends on a hidden name', async () => {
    await bigRepo();
    const visible = (path: string) => !/[13579]\.txt$/.test(path);
    const first = await listRepoDirectory(project, 'main', 'a', { limit: 500, visible });
    expect(first.entries).toHaveLength(500);
    expect(first.entries.every((e) => visible(e.path))).toBe(true);
    expect(first.nextKey).toBe('a/f0998.txt');
    const second = await listRepoDirectory(project, 'main', 'a', {
      limit: 500,
      visible,
      after: { commit: first.commit!, key: first.nextKey! },
    });
    expect(second.entries).toHaveLength(100);
    expect(second.truncated).toBe(false);
    expect(second.nextKey).toBeNull();
  });

  test('a cursor commit this mirror lacks fetches once, then falls back to the ref tip with the same key', async () => {
    await bigRepo();
    const listing = await listRepoDirectory(project, 'main', 'a', {
      limit: 500,
      after: { commit: 'f'.repeat(40), key: 'a/f0499.txt' },
    });
    expect(refreshes).toContain(true);
    expect(listing.commit).toBe(await headSha());
    expect(listing.entries[0]!.path).toBe('a/f0500.txt');
    expect(listing.entries).toHaveLength(500);
  });
});

describe('directory cursor', () => {
  const commit = 'a'.repeat(40);

  test('round-trips the commit and key for the same folder', () => {
    const cursor = encodeDirectoryCursor(commit, 'src/app', 'src/app/page.tsx');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDirectoryCursor(cursor, 'src/app')).toEqual({ commit, key: 'src/app/page.tsx' });
    expect(decodeDirectoryCursor(cursor, 'src/app/')).toEqual({ commit, key: 'src/app/page.tsx' });
    expect(decodeDirectoryCursor(encodeDirectoryCursor(commit, null, 'README.md'), undefined)).toEqual({ commit, key: 'README.md' });
  });

  test('refuses a cursor of another folder, garbage, an unknown version, or a commit that is not a sha', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(decodeDirectoryCursor(encodeDirectoryCursor(commit, 'src', 'src/a'), 'lib')).toBeNull();
    expect(decodeDirectoryCursor(encodeDirectoryCursor(commit, 'src', 'src/a'), null)).toBeNull();
    expect(decodeDirectoryCursor('garbage', 'src')).toBeNull();
    expect(decodeDirectoryCursor('', 'src')).toBeNull();
    expect(decodeDirectoryCursor(encode({ v: 2, c: commit, p: 'src', k: 'src/a' }), 'src')).toBeNull();
    expect(decodeDirectoryCursor(encode({ v: 1, c: '--output=/tmp/x', p: 'src', k: 'src/a' }), 'src')).toBeNull();
    expect(decodeDirectoryCursor(encode({ v: 1, c: commit, p: 'src', k: '' }), 'src')).toBeNull();
    expect(decodeDirectoryCursor(encode({ v: 1, c: commit, p: '../x', k: 'a' }), '../x')).toBeNull();
  });
});

describe('readRepoFileBytes', () => {
  test('returns a committed binary file byte-accurate', async () => {
    await initRealRepo();
    await commitFiles({ 'logo.png': PNG_LIKE_BYTES });

    const bytes = await readRepoFileBytes(project, 'logo.png', 'main');
    expect(Buffer.compare(bytes, PNG_LIKE_BYTES)).toBe(0);
  });

  test('returns a committed text file byte-accurate', async () => {
    await initRealRepo();
    await commitFiles({ 'notes.txt': 'hello\nworld\n' });

    const bytes = await readRepoFileBytes(project, 'notes.txt', 'main');
    expect(Buffer.compare(bytes, Buffer.from('hello\nworld\n', 'utf8'))).toBe(0);
  });

  test('a nested path round-trips byte-accurate', async () => {
    await initRealRepo();
    await commitFiles({ 'assets/doc.bin': PNG_LIKE_BYTES });

    const bytes = await readRepoFileBytes(project, 'assets/doc.bin', 'main');
    expect(Buffer.compare(bytes, PNG_LIKE_BYTES)).toBe(0);
  });

  test('a binary read through the string path is lossy — the defect this fixes', async () => {
    await initRealRepo();
    await commitFiles({ 'logo.png': PNG_LIKE_BYTES });

    const lossy = await readRepoFile(project, 'logo.png', 'main');
    // The string read cannot represent the bytes: invalid UTF-8 became
    // replacement characters, so what the API served was not the file.
    const reEncoded = Buffer.from(lossy, 'utf8');
    expect(Buffer.compare(reEncoded, PNG_LIKE_BYTES)).not.toBe(0);
    expect(lossy).toContain('\uFFFD');
  });

  test('a missing file throws the same typed error as the string read', async () => {
    await initRealRepo();
    await commitFiles({});

    let caught: unknown;
    try {
      await readRepoFileBytes(project, 'nope.bin', 'main');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('RepoFileNotFoundError');
  });
});
