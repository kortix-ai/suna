import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import * as tar from 'tar';
import type { GitBackedProject } from '../projects/git/types';
import { buildRepoSnapshot, discardBuiltRepoSnapshot } from './build';
import {
  REPO_SNAPSHOT_EMBEDDED_MANIFEST,
  REPO_SNAPSHOT_FORMAT,
  normalizeRepoSnapshotIdentity,
  parseRepoSnapshotManifest,
  serializeRepoSnapshotManifest,
} from './format';

const roots: string[] = [];
const originalMirrorRoot = process.env.KORTIX_GIT_CACHE_DIR;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Snapshot Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Snapshot Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
    encoding: 'utf8',
  }).trim();
}

interface Fixture {
  project: GitBackedProject;
  headSha: string;
  firstSha: string;
  source: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'kortix-snapshot-source-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(['init', '-b', 'main'], source);
  writeFileSync(join(source, 'README.md'), 'first\n');
  git(['add', '-A'], source);
  git(['commit', '-m', 'first'], source);
  const firstSha = git(['rev-parse', 'HEAD'], source);

  writeFileSync(join(source, 'README.md'), 'second\n');
  writeFileSync(join(source, '.gitattributes'), '*.bin binary\n');
  mkdirSync(join(source, '.kortix', 'skills', 'unused-skill'), { recursive: true });
  writeFileSync(join(source, '.kortix', 'skills', 'unused-skill', 'SKILL.md'), '# never attached\n');
  mkdirSync(join(source, 'nested', 'project-root'), { recursive: true });
  writeFileSync(join(source, 'nested', 'project-root', 'kortix.yaml'), 'kortix_version: 2\n');
  writeFileSync(join(source, 'assets.bin'), Buffer.from([0, 1, 2, 255, 254, 0]));
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
      gitAuthToken: null,
    },
    headSha: git(['rev-parse', 'HEAD'], source),
    firstSha,
    source,
  };
}

function useIsolatedMirror(): void {
  const cache = mkdtempSync(join(tmpdir(), 'kortix-snapshot-mirror-'));
  roots.push(cache);
  process.env.KORTIX_GIT_CACHE_DIR = cache;
}

async function extract(archivePath: string, compression: 'gzip' | 'zstd'): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'kortix-snapshot-extract-'));
  roots.push(out);
  if (compression === 'gzip') {
    await tar.x({ file: archivePath, cwd: out });
    return out;
  }
  const { createReadStream } = await import('node:fs');
  const { createDecompressor } = await import('./codec');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(createReadStream(archivePath), createDecompressor('zstd'), tar.x({ cwd: out }));
  return out;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalMirrorRoot === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = originalMirrorRoot;
});

describe('buildRepoSnapshot', () => {
  test('packages the exact commit with sanitized, project-neutral Git metadata', async () => {
    useIsolatedMirror();
    const fixture = makeFixture();
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId: '123456',
      owner: 'Kortix-AI',
      repo: 'Fixture.git',
      commitSha: fixture.headSha,
    });
    expect(identity.owner).toBe('kortix-ai');
    expect(identity.repo).toBe('fixture');

    const built = await buildRepoSnapshot(fixture.project, identity, { compression: 'gzip' });
    try {
      expect(built.manifest.source.commit_sha).toBe(fixture.headSha);
      expect(built.manifest.payload.compression).toBe('gzip');
      expect(built.manifest.payload.key).toContain(
        `kortix-ai/fixture/${fixture.headSha}/123456/project-snapshot-v1/`,
      );
      // The round trip proves the manifest validates against its own identity.
      const reparsed = parseRepoSnapshotManifest(serializeRepoSnapshotManifest(built.manifest));
      expect(reparsed).toEqual(built.manifest);

      const out = await extract(built.archivePath, 'gzip');
      // Content parity with the source revision.
      expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('second\n');
      expect(readFileSync(join(out, '.kortix/skills/unused-skill/SKILL.md'), 'utf8')).toBe(
        '# never attached\n',
      );
      expect(readFileSync(join(out, 'nested/project-root/kortix.yaml'), 'utf8')).toBe(
        'kortix_version: 2\n',
      );
      expect([...readFileSync(join(out, 'assets.bin'))]).toEqual([0, 1, 2, 255, 254, 0]);
      const { lstatSync, readlinkSync, statSync } = await import('node:fs');
      expect(readlinkSync(join(out, 'readme-link'))).toBe('README.md');
      expect(lstatSync(join(out, 'readme-link')).isSymbolicLink()).toBe(true);
      expect(statSync(join(out, 'run.sh')).mode & 0o111).not.toBe(0);

      // Git metadata is self-contained, sanitized and carries no project identity.
      const gitConfig = readFileSync(join(out, '.git/config'), 'utf8');
      expect(gitConfig).not.toContain('[remote');
      expect(gitConfig).not.toContain('credential');
      expect(gitConfig).not.toContain(fixture.source);
      expect(gitConfig).toContain('ignorecase = false');
      expect(() => readFileSync(join(out, '.git/logs/HEAD'))).toThrow();
      expect(() => readFileSync(join(out, '.git/objects/info/alternates'))).toThrow();

      const embedded = JSON.parse(readFileSync(join(out, REPO_SNAPSHOT_EMBEDDED_MANIFEST), 'utf8'));
      expect(embedded.format).toBe(REPO_SNAPSHOT_FORMAT);
      expect(embedded.source.commit_sha).toBe(fixture.headSha);
      expect(embedded.source.repository_id).toBe('123456');
      expect(JSON.stringify(embedded)).not.toContain(fixture.project.projectId);

      // The extracted tree is a working repository with no source mirror present.
      rmSync(fixture.source, { recursive: true, force: true });
      expect(git(['rev-parse', 'HEAD'], out)).toBe(fixture.headSha);
      expect(git(['status', '--porcelain'], out)).toBe('');
      expect(git(['remote'], out)).toBe('');
    } finally {
      await discardBuiltRepoSnapshot(built);
    }
  }, 120_000);

  test('packages an older commit even after the branch moved past it', async () => {
    useIsolatedMirror();
    const fixture = makeFixture();
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId: '77',
      owner: 'kortix-ai',
      repo: 'fixture',
      commitSha: fixture.firstSha,
    });
    const built = await buildRepoSnapshot(fixture.project, identity, { compression: 'gzip' });
    try {
      expect(built.manifest.source.commit_sha).toBe(fixture.firstSha);
      const out = await extract(built.archivePath, 'gzip');
      expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('first\n');
      expect(git(['rev-parse', 'HEAD'], out)).toBe(fixture.firstSha);
    } finally {
      await discardBuiltRepoSnapshot(built);
    }
  }, 120_000);

  test('produces byte-identical archives for one revision (deterministic bytes)', async () => {
    useIsolatedMirror();
    const fixture = makeFixture();
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId: '99',
      owner: 'kortix-ai',
      repo: 'fixture',
      commitSha: fixture.headSha,
    });
    const first = await buildRepoSnapshot(fixture.project, identity, { compression: 'gzip' });
    const second = await buildRepoSnapshot(fixture.project, identity, { compression: 'gzip' });
    try {
      expect(second.manifest.payload.sha256).toBe(first.manifest.payload.sha256);
      expect(second.manifest.payload.compressed_bytes).toBe(first.manifest.payload.compressed_bytes);
    } finally {
      await discardBuiltRepoSnapshot(first);
      await discardBuiltRepoSnapshot(second);
    }
  }, 180_000);

  test('supports zstd with the extension and manifest in agreement', async () => {
    useIsolatedMirror();
    const fixture = makeFixture();
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId: '1010',
      owner: 'kortix-ai',
      repo: 'fixture',
      commitSha: fixture.headSha,
    });
    const built = await buildRepoSnapshot(fixture.project, identity, { compression: 'zstd' });
    try {
      expect(built.manifest.payload.compression).toBe('zstd');
      expect(built.manifest.payload.key.endsWith('.tar.zst')).toBe(true);
      expect(built.archivePath.endsWith('.tar.zst')).toBe(true);
      const out = await extract(built.archivePath, 'zstd');
      expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('second\n');
    } finally {
      await discardBuiltRepoSnapshot(built);
    }
  }, 120_000);

  test('refuses a commit the mirror cannot produce', async () => {
    useIsolatedMirror();
    const fixture = makeFixture();
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId: '5',
      owner: 'kortix-ai',
      repo: 'fixture',
      commitSha: 'a'.repeat(40),
    });
    await expect(buildRepoSnapshot(fixture.project, identity, { compression: 'gzip' })).rejects.toThrow(
      /not reachable/,
    );
  }, 120_000);
});
