import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import * as tar from 'tar';
import type { GitBackedProject } from '../projects/git/types';
import {
  COMPILED_CHECKOUT_FORMAT,
  __clearCompiledCheckoutBuildsForTests,
  buildCompiledCheckoutArtifact,
} from './compiled-checkout';

const roots: string[] = [];
const originalCacheRoot = process.env.KORTIX_COMPILED_BOOT_CACHE_DIR;
const originalMirrorRoot = process.env.KORTIX_GIT_CACHE_DIR;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ivan Bagarić',
      GIT_AUTHOR_EMAIL: 'ino.bagaric.1@gmail.com',
      GIT_COMMITTER_NAME: 'Ivan Bagarić',
      GIT_COMMITTER_EMAIL: 'ino.bagaric.1@gmail.com',
    },
    encoding: 'utf8',
  }).trim();
}

function makeProject(): { project: GitBackedProject; sha: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'kortix-compiled-source-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(['init', '-b', 'main'], source);
  writeFileSync(join(source, 'README.md'), 'first\n');
  git(['add', '-A'], source);
  git(['commit', '-m', 'first'], source);
  writeFileSync(join(source, 'README.md'), 'second\n');
  mkdirSync(join(source, '.kortix', 'memory'), { recursive: true });
  writeFileSync(join(source, '.kortix', 'memory', 'MEMORY.md'), 'Remember the customer context.\n');
  writeFileSync(join(source, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  symlinkSync('README.md', join(source, 'readme-link'));
  git(['add', '-A'], source);
  git(['commit', '-m', 'second'], source);
  return {
    project: {
      projectId: crypto.randomUUID(),
      repoUrl: `file://${source}`,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: 'test-token',
    },
    sha: git(['rev-parse', 'HEAD'], source),
    source,
  };
}

afterEach(() => {
  __clearCompiledCheckoutBuildsForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalCacheRoot === undefined) delete process.env.KORTIX_COMPILED_BOOT_CACHE_DIR;
  else process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = originalCacheRoot;
  if (originalMirrorRoot === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = originalMirrorRoot;
});

describe('buildCompiledCheckoutArtifact', () => {
  test('compiles an exact shallow checkout with working Git state', async () => {
    const { project, sha } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), 'kortix-compiled-cache-'));
    const mirrors = mkdtempSync(join(tmpdir(), 'kortix-compiled-mirrors-'));
    roots.push(cache, mirrors);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    const artifact = await buildCompiledCheckoutArtifact(
      project,
      'main',
      sha,
      `https://api.kortix.test/v1/git/${project.projectId}.git`,
    );
    const extracted = await mkdtemp(join(tmpdir(), 'kortix-compiled-extract-'));
    roots.push(extracted);
    await tar.extract({ cwd: extracted, file: artifact.path });

    expect(artifact.cacheHit).toBe(false);
    expect(artifact.size).toBeGreaterThan(0);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(extracted, 'README.md'), 'utf8')).toBe('second\n');
    expect(readFileSync(join(extracted, '.kortix', 'memory', 'MEMORY.md'), 'utf8')).toBe(
      'Remember the customer context.\n',
    );
    expect(git(['rev-parse', 'HEAD'], extracted)).toBe(sha);
    expect(git(['rev-list', '--count', 'HEAD'], extracted)).toBe('1');
    expect(git(['status', '--porcelain'], extracted)).toBe('');
    expect(git(['config', '--get', 'remote.origin.url'], extracted)).toBe(
      `https://api.kortix.test/v1/git/${project.projectId}.git`,
    );
    writeFileSync(join(extracted, 'agent-output.txt'), 'new work\n');
    git(['add', 'agent-output.txt'], extracted);
    git(['commit', '-m', 'agent work'], extracted);
    expect(git(['show', 'HEAD:agent-output.txt'], extracted)).toBe('new work');
    expect(JSON.parse(readFileSync(join(extracted, '.git', 'kortix-compiled-checkout.json'), 'utf8')))
      .toEqual({
        format: COMPILED_CHECKOUT_FORMAT,
        project_id: project.projectId,
        ref: 'main',
        source_sha: sha,
        shallow: true,
      });
  });

  test('reuses a content-addressed artifact for the same source commit', async () => {
    const { project, sha } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), 'kortix-compiled-cache-'));
    const mirrors = mkdtempSync(join(tmpdir(), 'kortix-compiled-mirrors-'));
    roots.push(cache, mirrors);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    const first = await buildCompiledCheckoutArtifact(project, 'main', sha, 'https://api.test/repo');
    const second = await buildCompiledCheckoutArtifact(project, 'main', sha, 'https://api.test/repo');

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.sha256).toBe(first.sha256);
  });

  test('rejects an artifact request when the named ref does not match the expected commit', async () => {
    const { project } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), 'kortix-compiled-cache-'));
    const mirrors = mkdtempSync(join(tmpdir(), 'kortix-compiled-mirrors-'));
    roots.push(cache, mirrors);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    await expect(
      buildCompiledCheckoutArtifact(project, 'main', 'a'.repeat(40), 'https://api.test/repo'),
    ).rejects.toThrow(/source moved/);
  });
});
