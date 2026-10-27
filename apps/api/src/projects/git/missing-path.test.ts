import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepoFile, readRepoFileBytes, RepoFileNotFoundError } from './files';
import { refreshMirror, isGitPathNotFoundError, runGit } from './mirror';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('recognizes missing committed paths whether or not they exist on disk', async () => {
  root = await mkdtemp(join(tmpdir(), 'kortix-missing-path-'));
  await runGit(['init', root], undefined, false);
  await runGit(['-c', 'user.name=Kortix Test', '-c', 'user.email=agent@kortix.ai', 'commit', '--allow-empty', '-m', 'empty'], root, false);
  const tree = (await runGit(['rev-parse', 'HEAD'], root, false)).stdout.trim();
  await mkdir(join(root, 'untracked'));
  await writeFile(join(root, 'untracked.txt'), 'not committed');
  for (const path of ['.', 'untracked', 'untracked.txt', 'absent.txt']) {
    let failure: unknown;
    try { await runGit(['show', `${tree}:${path}`], root, false); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(isGitPathNotFoundError(failure)).toBe(true);
  }
  let invalidRef: unknown;
  try { await runGit(['show', 'missing-ref:file.txt'], root, false); } catch (error) { invalidRef = error; }
  expect(invalidRef).toBeInstanceOf(Error);
  expect(isGitPathNotFoundError(invalidRef)).toBe(false);
});

test('file readers return typed missing-file errors for paths present in the bare mirror only', async () => {
  root = await mkdtemp(join(tmpdir(), 'kortix-missing-file-'));
  const previous = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
  try {
    const source = join(root, 'source');
    await runGit(['init', source], undefined, false);
    await runGit(['-c', 'user.name=Kortix Test', '-c', 'user.email=agent@kortix.ai', 'commit', '--allow-empty', '-m', 'empty'], source, false);
    const ref = (await runGit(['rev-parse', 'HEAD'], source, false)).stdout.trim();
    const project = { projectId: root, repoUrl: source, defaultBranch: ref, gitAuthToken: 'synthetic' };
    const mirror = await refreshMirror(project);
    await writeFile(join(mirror, 'untracked.txt'), 'not committed');
    await expect(readRepoFile(project, 'untracked.txt')).rejects.toBeInstanceOf(RepoFileNotFoundError);
    await expect(readRepoFileBytes(project, 'untracked.txt')).rejects.toBeInstanceOf(RepoFileNotFoundError);
  } finally {
    if (previous === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
    else process.env.KORTIX_GIT_CACHE_DIR = previous;
  }
});
