import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { resolveCommitShaAt } from './commits';
import {
  buildScaffoldDeltaBundle,
  resolveScaffoldDeltaBoundary,
  writeScaffoldDeltaBundle,
} from './fast-boot-bundle';

function git(args: string[], cwd: string, env?: Record<string, string>): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const output = execFileSync('git', args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    }).trim();
    // A successful rev-parse always prints an object ID. Bun's child-process
    // capture can return an empty string under the parallel package gate.
    if (args[0] !== 'rev-parse' || output) return output;
  }
  throw new Error(`git ${args.join(' ')} returned an empty object ID`);
}

describe('resolveCommitShaAt', () => {
  test('resolves a real branch to its exact commit SHA', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-resolve-sha-'));
    try {
      const source = join(root, 'source');
      mkdirSync(source);
      git(['init', '-b', 'main'], source);
      writeFileSync(join(source, 'README.md'), 'x\n');
      git(['add', 'README.md'], source);
      git(['commit', '-m', 'init'], source);
      const sha = git(['rev-parse', 'HEAD'], source);
      await expect(resolveCommitShaAt(source, 'main')).resolves.toBe(sha);
      await expect(resolveCommitShaAt(source, 'HEAD')).resolves.toBe(sha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an unresolvable ref with git\'s own failure, not the hex check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-resolve-sha-'));
    try {
      const source = join(root, 'source');
      mkdirSync(source);
      git(['init', '-b', 'main'], source);
      git(['commit', '-q', '--allow-empty', '-m', 'init'], source);
      await expect(resolveCommitShaAt(source, 'does-not-exist')).rejects.toThrow(
        /Needed a single revision/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildScaffoldDeltaBundle', () => {
  const PINNED = {
    GIT_AUTHOR_NAME: 'Kortix',
    GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
    GIT_COMMITTER_NAME: 'Kortix',
    GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
  };

  function seedProject(root: string, commits: number, opts: { bigFile?: number } = {}) {
    const source = join(root, 'source');
    const scaffoldRepo = join(root, 'scaffold.git');
    mkdirSync(source);
    git(['init', '-b', 'main'], source);
    writeFileSync(join(source, 'README.md'), 'generic scaffold\n');
    git(['add', 'README.md'], source);
    git(['commit', '-m', 'chore: scaffold Kortix project'], source, PINNED);
    const scaffoldSha = git(['rev-parse', 'HEAD'], source);
    const scaffoldTree = git(['rev-parse', 'HEAD^{tree}'], source);
    git(['clone', '--bare', '-q', source, scaffoldRepo], root);
    for (let i = 1; i <= commits; i += 1) {
      writeFileSync(join(source, `file-${i}.txt`), `change ${i}\n`);
      if (opts.bigFile && i === commits) {
        writeFileSync(join(source, 'blob.bin'), randomBytes(opts.bigFile));
      }
      git(['add', '-A'], source);
      git(['commit', '-m', `feat: change ${i}`], source, PINNED);
    }
    return { source, scaffoldRepo, scaffoldSha, scaffoldTree, baseSha: git(['rev-parse', 'HEAD'], source) };
  }

  test('bundles EVERY commit above the scaffold root, not just the tip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-scaffold-delta-'));
    try {
      const p = seedProject(root, 7);
      const delta = await buildScaffoldDeltaBundle(p.source, 'main', { scaffoldTreeSha: p.scaffoldTree });
      expect(delta?.baseSha).toBe(p.baseSha);
      expect(delta?.parentSha).toBe(p.scaffoldSha);
      expect(delta?.bundleBase64).toBeTruthy();
      const scaffold = join(root, 'scaffold');
      git(['clone', '-q', p.scaffoldRepo, scaffold], root);
      const bundlePath = join(root, 'delta.bundle');
      writeFileSync(bundlePath, Buffer.from(delta!.bundleBase64!, 'base64'));
      git(['bundle', 'unbundle', bundlePath], scaffold);
      git(['checkout', '-q', '-B', 'main', p.baseSha], scaffold);
      expect(git(['rev-parse', 'HEAD'], scaffold)).toBe(p.baseSha);
      expect(git(['rev-list', '--count', 'HEAD'], scaffold)).toBe('8');
      expect(readFileSync(join(scaffold, 'file-7.txt'), 'utf8')).toBe('change 7\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('marks a delta REMOTE when it no longer fits the env cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-scaffold-delta-'));
    try {
      const p = seedProject(root, 2, { bigFile: 200 * 1024 });
      const delta = await buildScaffoldDeltaBundle(p.source, 'main', { scaffoldTreeSha: p.scaffoldTree });
      expect(delta?.baseSha).toBe(p.baseSha);
      expect(delta?.parentSha).toBe(p.scaffoldSha);
      expect(delta?.bundleBase64).toBeNull();
      expect(delta?.bundleBytes).toBeGreaterThan(24 * 1024);
      // The download route writes the same bundle from the mirror.
      const out = join(root, 'remote.bundle');
      const size = await writeScaffoldDeltaBundle(p.source, 'main', p.baseSha, p.scaffoldSha, out);
      expect(size).toBe(delta!.bundleBytes);
      const verify = git(['bundle', 'verify', out], p.source);
      expect(verify).toContain(`${p.baseSha} refs/heads/main`);
      expect(verify).toContain(p.scaffoldSha);
      await expect(
        writeScaffoldDeltaBundle(p.source, 'main', 'f'.repeat(40), p.scaffoldSha, join(root, 'x.bundle')),
      ).rejects.toThrow(/is at/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips repos that are the bare scaffold or that never descended from it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-scaffold-delta-'));
    try {
      const p = seedProject(root, 0);
      expect(await buildScaffoldDeltaBundle(p.source, 'main')).toBeNull();
      mkdirSync(join(root, "q"));
      const q = seedProject(join(root, "q"), 3);
      // Unrelated starter tree → no delta (its "delta" would be the whole history).
      expect(await buildScaffoldDeltaBundle(q.source, 'main', { scaffoldTreeSha: 'a'.repeat(40) })).toBeNull();
      expect(await resolveScaffoldDeltaBoundary(q.source, 'main', { scaffoldTreeSha: q.scaffoldTree })).toMatchObject({
        baseSha: q.baseSha,
        parentSha: q.scaffoldSha,
        commitCount: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('propagates a git failure instead of reporting a boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-scaffold-delta-'));
    try {
      const source = join(root, 'source');
      mkdirSync(source);
      git(['init', '-b', 'main'], source);
      git(['commit', '-q', '--allow-empty', '-m', 'init'], source);
      await expect(resolveScaffoldDeltaBoundary(source, 'does-not-exist')).rejects.toThrow(
        /Needed a single revision/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
