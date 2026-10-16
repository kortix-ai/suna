import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import { newManifestVersion } from './manifest-version';
import { buildProjectSeedFiles } from './seed-files';

const yamlOf = (files: Array<{ path: string; content: string }>) =>
  files.find((file) => file.path === 'kortix.yaml')?.content ?? '';

describe('the kortix_version Kortix writes for a new manifest', () => {
  test('is 2 while manifest_v3 is off (the default), 3 when the project or the deployment turns it on', () => {
    const previous = config.MANIFEST_V3_DEFAULT_ENABLED;
    try {
      config.MANIFEST_V3_DEFAULT_ENABLED = false;
      expect(newManifestVersion()).toBe(2);
      expect(newManifestVersion({ experimental: { manifest_v3: true } })).toBe(3);
      config.MANIFEST_V3_DEFAULT_ENABLED = true;
      expect(newManifestVersion()).toBe(3);
      expect(newManifestVersion({ experimental: { manifest_v3: false } })).toBe(2);
    } finally {
      config.MANIFEST_V3_DEFAULT_ENABLED = previous;
    }
  });

  test('the provision seed is the v2 starter by default and the v3 starter on request', async () => {
    const input = {
      projectName: 'Acme',
      repoFullName: 'acme/acme',
      template: 'general-knowledge-worker' as const,
      marketplaceItems: [],
      now: '2026-10-16T00:00:00.000Z',
    };
    const v2 = await buildProjectSeedFiles(input);
    const v3 = await buildProjectSeedFiles({ ...input, manifestVersion: 3 });

    expect(yamlOf(v2.files)).toMatch(/^kortix_version: 2$/m);
    expect(yamlOf(v2.baseFiles)).toMatch(/^kortix_version: 2$/m);
    expect(v2.files.some((file) => file.path === 'harnesses/opencode/opencode.jsonc')).toBe(true);
    expect(yamlOf(v3.files)).toMatch(/^kortix_version: 3$/m);
    expect(yamlOf(v3.baseFiles)).toMatch(/^kortix_version: 3$/m);
    expect(v3.files.some((file) => file.path.startsWith('harnesses/'))).toBe(false);
  });
});
