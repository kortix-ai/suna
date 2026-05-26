import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildRuntimeArtifactFingerprint } from '../snapshots/runtime-fingerprint';

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
