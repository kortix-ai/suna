import { describe, expect, test } from 'bun:test';

import { parseEnterpriseReleaseManifest } from '../release-contract.ts';

const HASH = 'a'.repeat(64);
const DIGEST = `sha256:${HASH}`;

function validManifest() {
  return {
    schema_version: 1,
    version: '0.9.84-e1',
    channel: 'stable',
    published_at: '2026-07-13T12:00:00Z',
    prod: { version: '0.9.84', source_sha: 'b'.repeat(40) },
    enterprise: { source_sha: 'c'.repeat(40) },
    compatibility: {
      architectures: ['amd64'],
      kubernetes_minor: ['1.32'],
      rollback_from: ['0.9.83-e2'],
    },
    images: {
      api: { source: `index.docker.io/kortix/kortix-api@${DIGEST}`, digest: DIGEST, customer_repository: 'api' },
      frontend: { source: `index.docker.io/kortix/kortix-frontend@${DIGEST}`, digest: DIGEST, customer_repository: 'frontend' },
      gateway: { source: `index.docker.io/kortix/kortix-gateway@${DIGEST}`, digest: DIGEST, customer_repository: 'gateway' },
    },
    artifacts: {
      platform_bundle: { target: 'releases/0.9.84-e1/platform.tar.gz', sha256: HASH, length: 100 },
      supabase_bundle: { target: 'releases/0.9.84-e1/supabase.tar.gz', sha256: HASH, length: 200 },
      cosign_public_key: { target: 'keys/cosign.pub', sha256: HASH, length: 300 },
      updater_binary: { target: 'releases/0.9.84-e1/updater-linux-amd64', sha256: HASH, length: 400 },
    },
    migrations: [{ id: '20260713_initial', sha256: HASH, reversible: true, backward_compatible: true }],
    health: { api_path: '/v1/health', frontend_path: '/api/health', expected_version: '0.9.84' },
  };
}

describe('enterprise release contract', () => {
  test('accepts a fully digest-pinned stable release', () => {
    const parsed = parseEnterpriseReleaseManifest(validManifest());
    expect(parsed.version).toBe('0.9.84-e1');
    expect(parsed.images.api.source).toEndWith(`@${DIGEST}`);
    expect(parsed.compatibility.architectures).toEqual(['amd64']);
  });

  test('rejects moving image tags even when a separate digest field is present', () => {
    const manifest = validManifest();
    manifest.images.api.source = 'index.docker.io/kortix/kortix-api:latest';
    expect(() => parseEnterpriseReleaseManifest(manifest)).toThrow('immutable ref');
  });

  test('rejects enterprise versions that do not extend the exact prod release', () => {
    const manifest = validManifest();
    manifest.prod.version = '0.9.83';
    expect(() => parseEnterpriseReleaseManifest(manifest)).toThrow('extend the exact prod.version');
  });

  test('health verifies the copied prod image version rather than pretending it was rebuilt', () => {
    const manifest = validManifest();
    manifest.health.expected_version = '0.9.84-e1';
    expect(() => parseEnterpriseReleaseManifest(manifest)).toThrow('immutable prod.version');
  });

  test('fails closed on unknown fields', () => {
    const manifest = { ...validManifest(), unsigned_escape_hatch: true };
    expect(() => parseEnterpriseReleaseManifest(manifest)).toThrow('unknown fields');
  });

  test('rejects traversal in signed target paths', () => {
    const manifest = validManifest();
    manifest.artifacts.platform_bundle.target = '../platform.tar.gz';
    expect(() => parseEnterpriseReleaseManifest(manifest)).toThrow('relative TUF target path');
  });
});
