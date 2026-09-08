import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildProjectSeedFiles } from '../seed-files';
import {
  buildScaffoldDeltaBundle,
  buildSingleParentDeltaBundle,
  resolveScaffoldDeltaBoundary,
  writeScaffoldDeltaBundle,
} from './commits';

function git(args: string[], cwd: string, env?: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }).trim();
}

describe('buildSingleParentDeltaBundle', () => {
  test('packages one exact commit on top of an image-baked parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-fast-boot-bundle-'));
    try {
      const source = join(root, 'source');
      const scaffoldRepo = join(root, 'scaffold.git');
      const scaffold = join(root, 'scaffold');
      mkdirSync(source);
      git(['init', '-b', 'main'], source);
      writeFileSync(join(source, 'README.md'), 'generic scaffold\n');
      git(['add', 'README.md'], source);
      git(['commit', '-m', 'chore: scaffold Kortix project'], source, {
        GIT_AUTHOR_NAME: 'Kortix',
        GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
        GIT_COMMITTER_NAME: 'Kortix',
        GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
      });
      const scaffoldSha = git(['rev-parse', 'HEAD'], source);
      git(['clone', '--bare', source, scaffoldRepo], root);

      writeFileSync(join(source, 'README.md'), 'customer project\n');
      git(['add', 'README.md'], source);
      git(['commit', '-m', 'chore: project setup'], source, {
        GIT_AUTHOR_NAME: 'Kortix',
        GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
        GIT_COMMITTER_NAME: 'Kortix',
        GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
      });
      const baseSha = git(['rev-parse', 'HEAD'], source);

      const bundle = await buildSingleParentDeltaBundle(source, 'main');
      expect(bundle?.baseSha).toBe(baseSha);
      expect(bundle?.parentSha).toBe(scaffoldSha);
      expect(bundle?.bundleBase64.length).toBeGreaterThan(0);

      git(['clone', '-q', scaffoldRepo, scaffold], root);
      const bundlePath = join(root, 'delta.bundle');
      writeFileSync(bundlePath, Buffer.from(bundle!.bundleBase64, 'base64'));
      git(['bundle', 'unbundle', bundlePath], scaffold);
      git(['checkout', '-q', '-B', 'main', baseSha], scaffold);

      expect(git(['rev-parse', 'HEAD'], scaffold)).toBe(baseSha);
      expect(readFileSync(join(scaffold, 'README.md'), 'utf8')).toBe('customer project\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('imports when the provider gives the matching scaffold tree a different commit SHA', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-provider-fast-boot-bundle-'));
    try {
      const bakedSource = join(root, 'baked-source');
      const providerSource = join(root, 'provider-source');
      const scaffoldRepo = join(root, 'scaffold.git');
      const checkout = join(root, 'checkout');
      mkdirSync(bakedSource);
      mkdirSync(providerSource);

      const identity = {
        GIT_AUTHOR_NAME: 'Kortix',
        GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
        GIT_COMMITTER_NAME: 'Kortix',
        GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
      };
      git(['init', '-b', 'main'], bakedSource);
      writeFileSync(join(bakedSource, 'README.md'), 'generic scaffold\n');
      git(['add', 'README.md'], bakedSource);
      git(['commit', '-m', 'chore: scaffold Kortix project'], bakedSource, {
        ...identity,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      });
      const bakedSha = git(['rev-parse', 'HEAD'], bakedSource);
      const bakedTree = git(['rev-parse', 'HEAD^{tree}'], bakedSource);
      git(['clone', '--bare', bakedSource, scaffoldRepo], root);

      git(['init', '-b', 'main'], providerSource);
      writeFileSync(join(providerSource, 'README.md'), 'generic scaffold\n');
      git(['add', 'README.md'], providerSource);
      git(['commit', '-m', 'chore: scaffold Kortix project'], providerSource, {
        ...identity,
        GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z',
      });
      const providerParentSha = git(['rev-parse', 'HEAD'], providerSource);
      expect(providerParentSha).not.toBe(bakedSha);
      expect(git(['rev-parse', 'HEAD^{tree}'], providerSource)).toBe(bakedTree);

      writeFileSync(join(providerSource, 'README.md'), 'customer project\n');
      git(['add', 'README.md'], providerSource);
      git(['commit', '-m', 'chore: project setup'], providerSource, {
        ...identity,
        GIT_AUTHOR_DATE: '2026-01-03T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-03T00:00:00Z',
      });
      const baseSha = git(['rev-parse', 'HEAD'], providerSource);
      const bundle = await buildSingleParentDeltaBundle(providerSource, 'main');
      expect(bundle?.baseSha).toBe(baseSha);
      expect(bundle?.parentSha).toBe(providerParentSha);
      expect(bundle?.parentCommitBase64).toBeTruthy();

      git(['clone', '-q', scaffoldRepo, checkout], root);
      const bundlePath = join(root, 'provider.bundle');
      const parentCommitPath = join(root, 'provider-parent.commit');
      writeFileSync(bundlePath, Buffer.from(bundle!.bundleBase64, 'base64'));
      writeFileSync(parentCommitPath, Buffer.from(bundle!.parentCommitBase64, 'base64'));
      expect(git(['hash-object', '-t', 'commit', '-w', parentCommitPath], checkout)).toBe(
        providerParentSha,
      );
      git(['bundle', 'unbundle', bundlePath], checkout);
      git(['checkout', '-q', '-B', 'main', baseSha], checkout);

      expect(git(['rev-parse', 'HEAD'], checkout)).toBe(baseSha);
      expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('customer project\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the current managed starter delta below the sandbox env limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-starter-fast-boot-bundle-'));
    try {
      const source = join(root, 'source');
      mkdirSync(source);
      git(['init', '-b', 'main'], source);
      const seed = await buildProjectSeedFiles({
        projectName: 'Boot Benchmark',
        repoFullName: 'boot-benchmark-project-id',
        template: 'general-knowledge-worker',
        now: '2026-08-20T00:00:00.000Z',
      });
      for (const file of seed.baseFiles) {
        const path = join(source, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      git(['add', '-A'], source);
      git(['commit', '-m', 'chore: scaffold Kortix project'], source, {
        GIT_AUTHOR_NAME: 'Kortix',
        GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
        GIT_COMMITTER_NAME: 'Kortix',
        GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
      });
      for (const file of seed.files) {
        const path = join(source, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      git(['add', '-A'], source);
      git(['commit', '-m', 'chore: project setup'], source, {
        GIT_AUTHOR_NAME: 'Kortix',
        GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
        GIT_COMMITTER_NAME: 'Kortix',
        GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
      });

      const bundle = await buildSingleParentDeltaBundle(source, 'main');
      expect(bundle).not.toBeNull();
      expect(
        Buffer.byteLength(bundle!.bundleBase64 + bundle!.parentCommitBase64, 'utf8'),
      ).toBeLessThanOrEqual(24 * 1024);
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
});
