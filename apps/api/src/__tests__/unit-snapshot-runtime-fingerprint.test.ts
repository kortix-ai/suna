import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildRuntimeArtifactFingerprint } from '../snapshots/runtime-fingerprint';
import { RUNTIME_ARTIFACT_EXCLUDE_NAMES } from '../snapshots/runtime-artifact-filter';

describe('buildRuntimeArtifactFingerprint', () => {
  test('is deterministic for the same runtime artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-fingerprint-'));
    try {
      await writeFile(join(root, 'agent'), 'agent-v1');
      await writeFile(join(root, 'entrypoint'), 'entrypoint-v1');
      await mkdir(join(root, 'cli'));
      await writeFile(join(root, 'cli', 'index.ts'), 'cli-v1');

      const input = {
        sandboxVersion: 'dev-test',
        opencodeVersion: '1.2.3',
        artifacts: [
          { label: 'kortix-agent', path: join(root, 'agent') },
          { label: 'kortix-entrypoint', path: join(root, 'entrypoint') },
          { label: 'kortix-agent-cli', path: join(root, 'cli') },
        ],
      };

      const a = await buildRuntimeArtifactFingerprint(input);
      const b = await buildRuntimeArtifactFingerprint({
        ...input,
        artifacts: [...input.artifacts].reverse(),
      });

      expect(a).toBe(b);
      expect(a.startsWith('kortix-runtime:dev-test:artifacts:')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('excludeNames skips matching dir entries (e.g. node_modules) so install state does not flip the fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-fingerprint-'));
    try {
      await mkdir(join(root, 'pkg'));
      await writeFile(join(root, 'pkg', 'index.ts'), 'src-v1');
      await mkdir(join(root, 'pkg', 'node_modules'));
      await writeFile(join(root, 'pkg', 'node_modules', 'lockfile-shim'), 'pnpm-state-v1');

      const artifacts = [
        { label: 'pkg', path: join(root, 'pkg'), excludeNames: ['node_modules'] },
      ];

      const before = await buildRuntimeArtifactFingerprint({
        sandboxVersion: 'dev-test',
        opencodeVersion: '1.2.3',
        artifacts,
      });

      await writeFile(join(root, 'pkg', 'node_modules', 'lockfile-shim'), 'pnpm-state-v2');

      const after = await buildRuntimeArtifactFingerprint({
        sandboxVersion: 'dev-test',
        opencodeVersion: '1.2.3',
        artifacts,
      });

      expect(after).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('runtime artifact excludes skip tests, docs, caches, and install state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-fingerprint-'));
    try {
      await mkdir(join(root, 'pkg'));
      await writeFile(join(root, 'pkg', 'index.ts'), 'src-v1');
      await mkdir(join(root, 'pkg', '__tests__'));
      await writeFile(join(root, 'pkg', '__tests__', 'index.test.ts'), 'test-v1');
      await mkdir(join(root, 'pkg', 'node_modules'));
      await writeFile(join(root, 'pkg', 'node_modules', 'shim'), 'install-v1');
      await writeFile(join(root, 'pkg', 'README.md'), 'docs-v1');

      const artifacts = [
        { label: 'pkg', path: join(root, 'pkg'), excludeNames: RUNTIME_ARTIFACT_EXCLUDE_NAMES },
      ];

      const before = await buildRuntimeArtifactFingerprint({
        sandboxVersion: 'dev-test',
        opencodeVersion: '1.2.3',
        artifacts,
      });

      await writeFile(join(root, 'pkg', '__tests__', 'index.test.ts'), 'test-v2');
      await writeFile(join(root, 'pkg', 'node_modules', 'shim'), 'install-v2');
      await writeFile(join(root, 'pkg', 'README.md'), 'docs-v2');

      const after = await buildRuntimeArtifactFingerprint({
        sandboxVersion: 'dev-test',
        opencodeVersion: '1.2.3',
        artifacts,
      });

      expect(after).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('changes when a copied runtime artifact changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-fingerprint-'));
    try {
      await writeFile(join(root, 'agent'), 'agent-v1');
      await mkdir(join(root, 'cli'));
      await writeFile(join(root, 'cli', 'index.ts'), 'cli-v1');

      const artifacts = [
        { label: 'kortix-agent', path: join(root, 'agent') },
        { label: 'kortix-agent-cli', path: join(root, 'cli') },
      ];

      const before = await buildRuntimeArtifactFingerprint({
        sandboxVersion: 'dev-test',
        opencodeVersion: '1.2.3',
        artifacts,
      });

      await writeFile(join(root, 'agent'), 'agent-v2');

      const after = await buildRuntimeArtifactFingerprint({
        sandboxVersion: 'dev-test',
        opencodeVersion: '1.2.3',
        artifacts,
      });

      expect(after).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
