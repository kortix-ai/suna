import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEnterpriseManifest } from '../manifest.ts';

describe('enterprise promotion manifest', () => {
  test('binds exact prod digests, reviewed compatibility, and artifact bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-enterprise-manifest-'));
    try {
      const platform = join(root, 'platform.tar.gz');
      const supabase = join(root, 'supabase.tar.gz');
      const key = join(root, 'cosign.pub');
      writeFileSync(platform, 'platform');
      writeFileSync(supabase, 'supabase');
      writeFileSync(key, 'public-key');
      const digest = `sha256:${'a'.repeat(64)}`;
      const manifest = buildEnterpriseManifest({
        enterpriseVersion: '0.9.84-e1',
        prodVersion: '0.9.84',
        sourceSha: 'b'.repeat(40),
        enterpriseSourceSha: 'd'.repeat(40),
        publishedAt: '2026-07-13T12:00:00.000Z',
        kubernetesMinor: ['1.32'],
        rollbackFrom: [],
        migrations: [{ id: 'baseline', sha256: 'c'.repeat(64), reversible: false, backward_compatible: false }],
        images: {
          api: { source: `docker.io/kortix/kortix-api@${digest}`, digest },
          frontend: { source: `docker.io/kortix/kortix-frontend@${digest}`, digest },
          gateway: { source: `docker.io/kortix/kortix-gateway@${digest}`, digest },
        },
        platformBundle: platform,
        supabaseBundle: supabase,
        cosignPublicKey: key,
        updaterBinary: key,
      });

      expect(manifest.version).toBe('0.9.84-e1');
      expect(manifest.prod.version).toBe('0.9.84');
      expect(manifest.images.api.source).toEndWith(`@${digest}`);
      expect(manifest.artifacts.platform_bundle.length).toBe(8);
      expect(manifest.artifacts.platform_bundle.sha256).toHaveLength(64);
      expect(manifest.compatibility.rollback_from).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses an enterprise revision that does not extend the prod version', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-enterprise-manifest-invalid-'));
    try {
      const artifact = join(root, 'artifact');
      writeFileSync(artifact, 'x');
      const digest = `sha256:${'a'.repeat(64)}`;
      expect(() => buildEnterpriseManifest({
        enterpriseVersion: '0.9.85-e1',
        prodVersion: '0.9.84',
        sourceSha: 'b'.repeat(40),
        enterpriseSourceSha: 'd'.repeat(40),
        publishedAt: '2026-07-13T12:00:00.000Z',
        kubernetesMinor: ['1.32'],
        rollbackFrom: [],
        migrations: [],
        images: {
          api: { source: `docker.io/kortix/kortix-api@${digest}`, digest },
          frontend: { source: `docker.io/kortix/kortix-frontend@${digest}`, digest },
          gateway: { source: `docker.io/kortix/kortix-gateway@${digest}`, digest },
        },
        platformBundle: artifact,
        supabaseBundle: artifact,
        cosignPublicKey: artifact,
        updaterBinary: artifact,
      })).toThrow('enterprise version must extend the exact prod.version');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
